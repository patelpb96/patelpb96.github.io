"""The noteworthy rule (code, versioned): when does a new score matter?

Rule v1, both parts computed only from comparable scores (same benchmark, same effort setting, or both blank):
  beats      the new score exceeds the best score in the frontier set by more than the benchmark's margin
  cheaper    the new score is within the margin of the best, at no more than `price_ratio` times its price
The frontier set is the top `frontier_k` models by the headline benchmark. Margins are fixed point values
per benchmark (default in caps.json), recorded with the rule version in every event. `price_ratio` is
provisional (0.25 = four times cheaper); tune it once real data exists.
"""
from __future__ import annotations


def _same_setup(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def latest_scores(scores: list[dict]) -> dict[tuple, dict]:
    best: dict[tuple, dict] = {}
    for s in scores:
        if s.get("status", "observed") != "observed" or s.get("value") is None:
            continue
        key = (s["model_id"], s["benchmark_id"], (s.get("effort") or "").strip().lower())
        cur = best.get(key)
        if not cur or (s["observed_at"], s["obs_id"]) > (cur["observed_at"], cur["obs_id"]):
            best[key] = s
    return best


def frontier_set(scores: list[dict], headline: str, k: int) -> list[str]:
    per_model: dict[str, float] = {}
    for (model_id, bench, _), s in latest_scores(scores).items():
        if bench == headline:
            per_model[model_id] = max(per_model.get(model_id, float("-inf")), s["value"])
    return [m for m, _ in sorted(per_model.items(), key=lambda kv: (-kv[1], kv[0]))[:k]]


def evaluate(new: dict, scores: list[dict], frontier: list[str], caps: dict, prices: dict[str, float] | None = None,
             higher_is_better: bool = True) -> dict | None:
    """Return an event dict if `new` (a score row) is noteworthy against `scores`, else None."""
    cfg = caps["noteworthy"]
    margin = cfg["margins"].get(new["benchmark_id"], cfg["default_margin_points"])
    sign = 1 if higher_is_better else -1
    rivals = [s for (m, b, _), s in latest_scores(scores).items()
              if b == new["benchmark_id"] and m in frontier and m != new["model_id"] and _same_setup(s.get("effort"), new.get("effort"))]
    if not rivals:
        return None                                   # nothing comparable to beat: not an event
    best = max(rivals, key=lambda s: sign * s["value"])
    gain = sign * (new["value"] - best["value"])
    base = {"model_id": new["model_id"], "benchmark_id": new["benchmark_id"], "rule_version": cfg["rule_version"],
            "margin": round(gain, 6), "beat_model_id": best["model_id"]}
    if gain > margin:
        return {**base, "kind": "beats",
                "reason": f"{new['value']} vs {best['value']} on {new['benchmark_id']} (needs > {margin} points)"}
    new_price, best_price = (prices or {}).get(new["model_id"]), (prices or {}).get(best["model_id"])
    if gain >= -margin and new_price and best_price and new_price <= best_price * cfg.get("price_ratio", 0.25):
        return {**base, "kind": "cheaper",
                "reason": f"within {margin} points of {best['model_id']} at ${new_price} vs ${best_price} per 1M tokens"}
    return None
