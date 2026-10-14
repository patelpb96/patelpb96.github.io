"""
Extensible player profiles.

A profile is a plain dict of attributes per player id. Attributes come from
named "providers": a provider is either a function (player_id, ctx) -> value,
or a static mapping {player_id: value}. Add or remove one at any time and
the store recomputes / drops just that attribute.

    store = ProfileStore.load("out/profiles.json")     # or ProfileStore(ids, ctx)
    store.add("age_at_first_top20", lambda pid, ctx: ...)
    store.add("nickname", {"D643": "Nole"})
    store.remove("height_cm")
    store.get("D643")            -> dict
    store.find("djok")           -> list of matching profiles
    store.save("out/profiles.json")
"""
from __future__ import annotations

import json
from typing import Any, Callable, Mapping


class ProfileStore:
    def __init__(self, player_ids, ctx: Any = None):
        self.ctx = ctx
        self.profiles: dict[str, dict] = {str(p): {"player_id": str(p)} for p in player_ids}
        self.providers: dict[str, Callable | Mapping | None] = {}
        self.order: list[str] = ["player_id"]

    # ---- attributes
    def add(self, name: str, provider: Callable[[int, Any], Any] | Mapping[int, Any], overwrite=True):
        if name in self.providers and not overwrite:
            raise KeyError(f"attribute {name!r} already exists")
        self.providers[name] = provider
        if name not in self.order:
            self.order.append(name)
        for pid, prof in self.profiles.items():
            if callable(provider):
                prof[name] = provider(pid, self.ctx)
            else:
                prof[name] = provider.get(pid)
        return self

    def remove(self, name: str):
        if name == "player_id":
            raise ValueError("player_id is the key and cannot be removed")
        self.providers.pop(name, None)
        if name in self.order:
            self.order.remove(name)
        for prof in self.profiles.values():
            prof.pop(name, None)
        return self

    def refresh(self, name: str | None = None):
        """Recompute function-backed attributes (all, or one) after the data changes."""
        for n in ([name] if name else list(self.providers)):
            p = self.providers.get(n)
            if callable(p):
                self.add(n, p)
        return self

    @property
    def attributes(self) -> list[str]:
        return list(self.order)

    # ---- players
    def add_player(self, pid: str):
        pid = str(pid)
        if pid not in self.profiles:
            self.profiles[pid] = {"player_id": pid}
            for n, p in self.providers.items():
                if p is None:
                    self.profiles[pid][n] = None
                else:
                    self.profiles[pid][n] = p(pid, self.ctx) if callable(p) else p.get(pid)
        return self

    def remove_player(self, pid: int):
        self.profiles.pop(str(pid), None)
        return self

    # ---- lookup
    def get(self, pid: int) -> dict:
        prof = self.profiles[str(pid)]
        return {k: prof.get(k) for k in self.order}

    def find(self, text: str) -> list[dict]:
        t = text.lower()
        return [self.get(pid) for pid, p in self.profiles.items() if t in str(p.get("name", "")).lower()]

    def where(self, **conds) -> list[dict]:
        return [self.get(pid) for pid, p in self.profiles.items() if all(p.get(k) == v for k, v in conds.items())]

    def to_frame(self):
        import pandas as pd
        return pd.DataFrame([self.get(pid) for pid in self.profiles]).set_index("player_id")

    # ---- persistence (values only; function providers are re-registered in code)
    def save(self, path: str):
        with open(path, "w") as f:
            json.dump({"attributes": self.order,
                       "profiles": {k: {a: v.get(a) for a in self.order} for k, v in self.profiles.items()}},
                      f, indent=1, default=str, ensure_ascii=False)

    @classmethod
    def load(cls, path: str, ctx: Any = None) -> "ProfileStore":
        with open(path) as f:
            d = json.load(f)
        s = cls([], ctx)
        s.order = d["attributes"]
        s.profiles = {str(k): v for k, v in d["profiles"].items()}
        s.providers = {a: None for a in s.order if a != "player_id"}  # stored values, no recompute
        return s
