"""Run caps: two runs a day, a call cap per run, a dollar cap per day, and a kill switch.

Local implementation of the guards the Lambda will need (the AWS version swaps the lock file for an S3
`If-None-Match: *` put and the spend file for an SSM parameter, like lambdas/rs_refresh and lambdas/search).

  * No retries: a slot's lock is taken once and never released, so a failed run is not silently re-run.
  * Spend is RESERVED before each call and settled to Exa's real costDollars afterwards, so a crash
    between the two can only over-count, never under-count.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path


class RunRefused(Exception):
    pass


class Budget:
    def __init__(self, data_dir: Path, caps: dict, now: datetime, est_call_usd: float | None = None):
        self.dir = Path(data_dir)
        self.caps = caps
        self.day = now.strftime("%Y-%m-%d")
        self.est = caps.get("est_call_usd", 0.05) if est_call_usd is None else est_call_usd
        self.calls_this_run = 0
        (self.dir / "locks").mkdir(parents=True, exist_ok=True)
        (self.dir / "spend").mkdir(parents=True, exist_ok=True)

    # -- guards ------------------------------------------------------------------------------------------

    def killed(self) -> bool:
        return os.environ.get("MODEL_TRACKER_KILL") == "1" or (self.dir / "KILL").exists()

    def start_run(self, slot: str) -> None:
        if self.killed():
            raise RunRefused("kill switch is set (MODEL_TRACKER_KILL=1 or data/KILL exists)")
        if not slot.startswith(self.day):
            raise RunRefused(f"slot {slot!r} is not on today's date {self.day}")
        today = sorted(p.name for p in (self.dir / "locks").glob(f"{self.day}*.lock"))
        if len(today) >= self.caps["n_daily_runs"]:
            raise RunRefused(f"already {len(today)} runs today (cap {self.caps['n_daily_runs']}): {today}")
        try:
            fd = os.open(self.dir / "locks" / f"{slot}.lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise RunRefused(f"slot {slot} already ran; runs are never retried") from None
        os.close(fd)

    # -- spend -------------------------------------------------------------------------------------------

    def _spend_path(self) -> Path:
        return self.dir / "spend" / f"{self.day}.json"

    def spent_today(self) -> float:
        try:
            return float(json.loads(self._spend_path().read_text(encoding="utf-8"))["usd"])
        except (OSError, ValueError, KeyError):
            return 0.0

    def _write_spend(self, usd: float) -> None:
        self._spend_path().write_text(json.dumps({"usd": round(usd, 6)}) + "\n", encoding="utf-8")

    def reserve(self) -> float:
        """Count one Exa call and set aside its estimated cost; refuse if either cap would be passed."""
        if self.killed():
            raise RunRefused("kill switch is set")
        if self.calls_this_run >= self.caps["max_exa_calls_per_run"]:
            raise RunRefused(f"call cap reached ({self.caps['max_exa_calls_per_run']} per run)")
        spent = self.spent_today()
        if spent + self.est > self.caps["daily_usd_cap"]:
            raise RunRefused(f"daily dollar cap: ${spent:.2f} spent + ${self.est:.2f} reserve > ${self.caps['daily_usd_cap']:.2f}")
        self.calls_this_run += 1
        self._write_spend(spent + self.est)
        return self.est

    def settle(self, reserved: float, actual: float | None) -> None:
        """Replace the reservation with the real cost; if Exa reported none, keep the reservation."""
        if actual is None:
            return
        self._write_spend(max(0.0, self.spent_today() - reserved + actual))
