"""
End-to-end build:

    python build.py <TML-Rankings-Database dir> <TML-Database dir> <out_dir> [today YYYY-MM-DD]

Outputs (out_dir):
  data_quality.md / .json        every check: counts, examples, corrective action
  rankings_clean.csv             all clean weekly ranking rows, 1973 ->
  top20s_year_end.csv            "Top20s": year-end top 20 for every finished season
  top20s_players.csv             unique players in Top20s (sorted by first name)
  top20s_21st_century.csv        "Top20s_21st_Century": Top20s players with a finish in 2000 or later
  rankings_top20s_players.csv    every weekly entry for every Top20s player (any rank)
  profiles.json                  ProfileStore dump (see profiles.py)
  explorer_data.json             compact data for the explorer page
"""
from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace

import numpy as np
import pandas as pd

import tennis_data as td
from profiles import ProfileStore

TOP = 20
CENTURY_START = 2000


def main(rank_repo, db_repo, out_dir, today=None):
    os.makedirs(out_dir, exist_ok=True)
    today = pd.Timestamp(today) if today else pd.Timestamp.today().normalize()
    log = td.IssueLog()

    players = td.clean_players(os.path.join(db_repo, "ATP_Database.csv"), log)

    # Primary: completed weekly set. Verification: lists as ATP published them.
    tml = td.clean_rankings(td.load_rankings(os.path.join(rank_repo, "TML Rankings")), players, log, "weekly")
    off = td.clean_rankings(td.load_rankings(os.path.join(rank_repo, "Official ATP Rankings")), players, log, "official")
    td.compare_with_official(tml, off, log, TOP)
    tml[tml["date"].dt.year < 1985].to_csv(f"{out_dir}/rankings_reconstructed_1973_1984.csv", index=False,
                                           date_format="%Y-%m-%d")
    r = td.build_canonical(tml, off, log)
    dates = td.check_calendar(r, log, "canonical")
    per = td.check_lists(r, log, "canonical", TOP)
    r = td.mark_spikes(r, dates, log, "canonical")
    players = td.check_players(players, set(r["player"]), log)

    # players that only exist as X:<name> ids get a minimal bio row
    extra = sorted(set(r["player"]) - set(players.index))
    if extra:
        names = r.drop_duplicates("player").set_index("player")["name"]
        add = pd.DataFrame({"name": [names[i] for i in extra]}, index=pd.Index(extra, name="player_id"))
        add["name_first"], add["name_last"] = zip(*add["name"].map(td.split_name))
        players = pd.concat([players, add])
    r["name"] = r["player"].map(players["name"])
    ye = td.year_end_top(r, per, players, log, TOP, today)

    # Weeks at No. 1, both data sets, against the official totals
    for label, frame in (("canonical", r[~r["suspect"]]), ("official only", off),
                         ("weekly reconstruction", tml)):
        dur = td.list_durations(frame["date"].unique())
        w = frame[frame["rank"] == 1].assign(days=lambda x: x["date"].map(dur))
        w = w.assign(name=w["player"].map(players["name"]).fillna(w["name"]))
        td.check_weeks_at_no1((w.groupby("name")["days"].sum() / 7).round(1).to_dict(), log, label)

    final = ye[ye["final"]]
    top20s_ids = sorted(final["player_id"].unique())
    c21_ids = sorted(final.loc[final["year"] >= CENTURY_START, "player_id"].unique())
    ye.to_csv(f"{out_dir}/top20s_year_end.csv", index=False, date_format="%Y-%m-%d")
    r.to_csv(f"{out_dir}/rankings_clean.csv", index=False, date_format="%Y-%m-%d")

    # ---------------- profiles
    good = r[~r["suspect"]]
    dur = td.list_durations(dates)
    good = good.assign(days=good["date"].map(dur))
    ctx = SimpleNamespace(players=players, rankings=dict(tuple(good.groupby("player"))),
                          year_end=final, dates=dates)
    ever20 = sorted(good.loc[good["rank"] <= TOP, "player"].unique())
    store = build_profiles(sorted(set(ever20) | set(top20s_ids)), ctx, top20s_ids, c21_ids)
    store.save(f"{out_dir}/profiles.json")
    prof = store.to_frame()

    def plist(ids):
        df = prof.loc[ids, ["name", "name_first", "name_last", "country", "dob", "career_high_rank",
                            "best_year_end_rank", "first_top20", "last_top20", "weeks_in_top20"]].copy()
        df["year_end_top20_years"] = [",".join(map(str, sorted(prof.at[i, "year_end_top20_finishes"]))) for i in ids]
        return df.sort_values("name", key=lambda s: s.map(td.norm_name))

    plist(top20s_ids).to_csv(f"{out_dir}/top20s_players.csv")
    plist(c21_ids).to_csv(f"{out_dir}/top20s_21st_century.csv")
    r[r["player"].isin(top20s_ids)].to_csv(f"{out_dir}/rankings_top20s_players.csv", index=False,
                                           date_format="%Y-%m-%d")

    with open(f"{out_dir}/explorer_data.json", "w") as f:
        json.dump(explorer_data(good, dates, store, final, ever20, today, log), f,
                  separators=(",", ":"), ensure_ascii=False, default=str)
    log.to_json(f"{out_dir}/data_quality.json")
    log.to_markdown(f"{out_dir}/data_quality.md")
    s = {"weekly_lists": len(dates), "first_list": f"{dates.min():%Y-%m-%d}", "last_list": f"{dates.max():%Y-%m-%d}",
         "finished_seasons": f"{int(final['year'].min())}-{int(final['year'].max())}",
         "top20s_players": len(top20s_ids), "top20s_21st_century_players": len(c21_ids),
         "ever_weekly_top20": len(ever20)}
    print(json.dumps(s, indent=1))
    return s


def build_profiles(ids, ctx, top20s_ids, c21_ids) -> ProfileStore:
    store = ProfileStore(ids, ctx)
    P = ctx.players
    empty = pd.DataFrame(columns=["date", "rank", "days"])

    def bio(col, conv=lambda v: v):
        def f(pid, c):
            if pid not in c.players.index or col not in c.players.columns:
                return None
            v = c.players.at[pid, col]
            return None if v is None or (not isinstance(v, str) and pd.isna(v)) else conv(v)
        return f

    rk = lambda pid, c: c.rankings.get(pid, empty)
    store.add("name", bio("name"))
    store.add("name_first", bio("name_first"))
    store.add("name_last", bio("name_last"))
    store.add("atp_id", lambda pid, c: None if str(pid).startswith("X:") else pid)
    store.add("country", bio("ioc"))
    store.add("dob", bio("dob", lambda v: f"{v:%Y-%m-%d}"))
    store.add("birthplace", bio("birthplace"))
    store.add("hand", bio("hand"))
    store.add("backhand", bio("backhand"))
    store.add("height_cm", bio("height", int))
    store.add("weight_kg", bio("weight", int))
    store.add("turned_pro", bio("turnedpro", int))
    store.add("coaches", bio("coaches"))
    s20, s21 = set(top20s_ids), set(c21_ids)
    store.add("in_top20s", lambda pid, c: pid in s20)
    store.add("in_top20s_21st_century", lambda pid, c: pid in s21)

    def career_high(pid, c):
        d = rk(pid, c)
        return None if d.empty else int(d["rank"].min())

    def career_high_date(pid, c):
        d = rk(pid, c)
        return None if d.empty else f"{d.loc[d['rank'] == d['rank'].min(), 'date'].min():%Y-%m-%d}"

    def weeks(limit):
        def f(pid, c):
            d = rk(pid, c)
            return round(float(d.loc[d["rank"] <= limit, "days"].sum()) / 7, 1)
        return f

    def when(limit, fn):
        def f(pid, c):
            d = rk(pid, c)
            d = d[d["rank"] <= limit]
            return None if d.empty else f"{getattr(d['date'], fn)():%Y-%m-%d}"
        return f

    def latest(pid, c):
        d = rk(pid, c)
        if d.empty:
            return None
        row = d.loc[d["date"].idxmax()]
        return {"rank": int(row["rank"]), "date": f"{row['date']:%Y-%m-%d}"}

    store.add("career_high_rank", career_high)
    store.add("career_high_first_date", career_high_date)
    store.add("weeks_at_no1", weeks(1))
    store.add("weeks_in_top10", weeks(10))
    store.add("weeks_in_top20", weeks(20))
    store.add("first_ranked", when(10**6, "min"))
    store.add("last_ranked", when(10**6, "max"))
    store.add("first_top20", when(TOP, "min"))
    store.add("last_top20", when(TOP, "max"))
    store.add("year_end_top20_finishes",
              lambda pid, c: {int(y): int(k) for y, k in c.year_end.loc[c.year_end["player_id"] == pid, ["year", "rank"]].values})
    store.add("best_year_end_rank",
              lambda pid, c: (lambda s: None if s.empty else int(s.min()))(c.year_end.loc[c.year_end["player_id"] == pid, "rank"]))
    store.add("latest_ranking", latest)
    return store


def explorer_data(good, dates, store, final, ids, today, log):
    di = {d: i for i, d in enumerate(dates)}
    good = good.assign(di=good["date"].map(di))
    out = []
    for pid, d in good[good["player"].isin(ids)].groupby("player"):
        d = d.sort_values("di")
        s, e = int(d["di"].min()), int(d["di"].max())
        ranks = np.zeros(e - s + 1, dtype=int)
        ranks[d["di"].values - s] = d["rank"].values
        runs = []  # top-20 runs [first, last] as global list indices; a 1-2 list hole doesn't split a run
        for k in d.loc[d["rank"] <= TOP, "di"].values:
            if runs and k - runs[-1][1] <= 3:
                runs[-1][1] = int(k)
            else:
                runs.append([int(k), int(k)])
        p = store.get(pid)
        out.append({"id": pid, "n": p["name"], "c": p["country"], "s": s, "r": ranks.tolist(), "t20": runs,
                    "ye": p["year_end_top20_finishes"], "hi": p["career_high_rank"],
                    "w1": p["weeks_at_no1"], "w20": p["weeks_in_top20"],
                    "a": int(p["in_top20s"]), "b": int(p["in_top20s_21st_century"]),
                    "p": {k: v for k, v in p.items() if v not in (None, "", {})}})
    issues = [{"s": i.severity, "c": i.check, "n": i.count, "a": i.action} for i in log.items]
    dur = td.list_durations(dates)
    return {"generated": f"{today:%Y-%m-%d}", "dates": [int(f"{d:%Y%m%d}") for d in dates],
            "dur": [int(dur[d]) for d in dates],
            "players": out, "finalSeasons": sorted(int(y) for y in final["year"].unique()), "issues": issues}


if __name__ == "__main__":
    main(*sys.argv[1:])
