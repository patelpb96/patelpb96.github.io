"""
Derived metrics for the explorer's "Top 10" group: whoever is ranked 1-10 on each list.

Ranks of the top 10 are always 1..10, so the group line plots properties of those players instead
(where they were ranked a year earlier, how many are new, their average age, ...).

    uv run --with polars python top10_metrics.py <TML-Rankings-Database dir> <TML-Database dir> <explorer_data.json> <out.json>

The full ranking history is needed (not just the Top20s players): 17 lists have a top-10 player who
never finished a season in the top 20, and "rank a year earlier" needs everyone's history.
Same canonical rules as build.py: official ATP lists before 1985, TML weekly lists from 1985 (plus any
official list with no weekly list within 6 days); a player listed twice on one list keeps the better rank.
"""
from __future__ import annotations

import glob
import json
import os
import sys
import unicodedata
from datetime import date

import polars as pl

TOP = 10
SHORT = {  # legend labels
    "prev_avg": "avg rank 1y before", "prev_median": "median rank 1y before", "next_avg": "avg rank 1y after",
    "new_year": "new vs 1y before", "out_year": "gone 1y after", "new_week": "changes per list",
    "age_avg": "avg age", "age_min": "youngest", "exp_avg": "avg weeks in top 10", "countries": "countries",
}
YEAR = 364  # days: same weekday a year earlier/later
CUTOVER = 1985


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    return " ".join("".join(c for c in s if not unicodedata.combining(c)).lower().replace("-", " ").split())


def load_lists(folder: str) -> pl.DataFrame:
    files = sorted(glob.glob(os.path.join(folder, "*.csv")))
    if not files:
        raise FileNotFoundError(folder)
    frames = [pl.read_csv(f, infer_schema_length=0, encoding="utf8-lossy") for f in files]
    r = pl.concat([f.select("date", "rank", "name", "id") for f in frames], how="vertical")
    return (r.with_columns(pl.col("date").str.strptime(pl.Date, "%Y%m%d", strict=False),
                           pl.col("rank").cast(pl.Int32, strict=False),
                           pl.col("id").str.strip_chars(),
                           pl.col("name").str.strip_chars())
             .filter(pl.col("date").is_not_null() & pl.col("rank").is_not_null() & pl.col("name").is_not_null()))


def resolve_ids(r: pl.DataFrame, bios: pl.DataFrame) -> pl.DataFrame:
    """Rows with no id: match the name to a single bio, else an 'X:<name>' id (as build.py does)."""
    missing = r.filter(pl.col("id").is_null() | (pl.col("id") == ""))["name"].unique().to_list()
    if not missing:
        return r
    index: dict[str, set] = {}
    for pid, a, b in bios.select("id", "player", "atpname").iter_rows():
        for nm in {a, b} - {None, ""}:
            index.setdefault(norm_name(nm), set()).add(pid)
    fix = {nm: (next(iter(h)) if len(h := index.get(norm_name(nm), set())) == 1 else "X:" + norm_name(nm).replace(" ", "-"))
           for nm in missing}
    return r.with_columns(pl.when(pl.col("id").is_null() | (pl.col("id") == ""))
                          .then(pl.col("name").replace_strict(fix, default=None)).otherwise(pl.col("id")).alias("id"))


def canonical(rank_repo: str, bios: pl.DataFrame) -> pl.DataFrame:
    off = resolve_ids(load_lists(os.path.join(rank_repo, "Official ATP Rankings")), bios)
    tml = resolve_ids(load_lists(os.path.join(rank_repo, "TML Rankings")), bios)
    early = off.filter(pl.col("date").dt.year() < CUTOVER)
    late = tml.filter(pl.col("date").dt.year() >= CUTOVER)
    # official lists from 1985 on that have no weekly list within 6 days
    td = late.select("date").unique().sort("date").with_columns(pl.col("date").alias("near"))
    od = off.filter(pl.col("date").dt.year() >= CUTOVER).select("date").unique().sort("date")
    near = pl.concat([od.join_asof(td, on="date", strategy=s).with_columns((pl.col("near") - pl.col("date")).dt.total_days().abs().alias("gap"))
                      for s in ("backward", "forward")])
    lonely = near.group_by("date").agg(pl.col("gap").min()).filter(pl.col("gap").is_null() | (pl.col("gap") > 6))["date"]
    extra = off.filter(pl.col("date").is_in(lonely.implode()))
    return (pl.concat([early, late, extra]).sort("date", "rank")
              .unique(["date", "id"], keep="first", maintain_order=True))  # listed twice: keep the better rank


def main(rank_repo: str, db_repo: str, explorer_json: str, out_path: str) -> None:
    bios = pl.read_csv(os.path.join(db_repo, "ATP_Database.csv"), infer_schema_length=0, encoding="utf8-lossy")
    lists = canonical(rank_repo, bios)

    ex = json.load(open(explorer_json, encoding="utf-8"))
    ex_dates = [date(d // 10000, d // 100 % 100, d % 100) for d in ex["dates"]]
    dates = pl.DataFrame({"date": ex_dates, "i": range(len(ex_dates)), "dur": ex["dur"]}, schema={"date": pl.Date, "i": pl.Int32, "dur": pl.Float64})
    have = set(lists["date"].unique().to_list())
    missing = [d for d in ex_dates if d not in have]
    if missing:
        raise SystemExit(f"{len(missing)} explorer lists not found in the source, e.g. {missing[:5]}")
    lists = lists.join(dates, on="date", how="inner")  # exactly the explorer's lists
    last_end = ex_dates[-1].toordinal() + ex["dur"][-1]

    # list in force on any day: as-of join against the list dates
    in_force = dates.select(pl.col("date").alias("ref"), pl.col("i").alias("ref_i")).sort("ref")

    def rank_on(top: pl.DataFrame, shift_days: int, name: str) -> pl.DataFrame:
        q = top.with_columns((pl.col("date") + pl.duration(days=shift_days)).alias("ref")).sort("ref")
        q = q.join_asof(in_force, on="ref", strategy="backward")
        if shift_days > 0:  # no list is "in force" past the end of the data
            q = q.with_columns(pl.when(pl.col("ref").cast(pl.Int32) + 719163 > last_end).then(None).otherwise(pl.col("ref_i")).alias("ref_i"))
        ranks = lists.select(pl.col("i").alias("ref_i"), "id", pl.col("rank").alias(name))
        return q.join(ranks, on=["ref_i", "id"], how="left").drop("ref", "ref_i")

    top = lists.filter(pl.col("rank") <= TOP).select("i", "date", "dur", "id", "name", "rank")
    top = rank_on(top, -YEAR, "rank_prev")
    top = rank_on(top, YEAR, "rank_next")
    top = top.with_columns(pl.col("i").cast(pl.Int32))
    has_next = top.select(pl.col("i"), (pl.col("date").cast(pl.Int32) + 719163 + YEAR <= last_end).alias("ok")).unique("i")

    # weeks already spent in the top 10 before this list (sum of list durations, per player)
    top = top.sort("i").with_columns((pl.col("dur").cum_sum().over("id") - pl.col("dur")).truediv(7).alias("wk_before"))
    # previous list's top 10, for week-on-week changes
    prev_members = top.select((pl.col("i") + 1).alias("i"), "id", pl.lit(True).alias("in_prev"))
    top = top.join(prev_members, on=["i", "id"], how="left")

    b = bios.select(pl.col("id"), pl.col("birthdate").str.strptime(pl.Date, "%Y%m%d", strict=False).alias("dob"), pl.col("ioc"))
    top = top.join(b, on="id", how="left").with_columns(((pl.col("date") - pl.col("dob")).dt.total_days() / 365.25).alias("age"))

    agg = (top.group_by("i").agg(
        pl.len().alias("n"),
        pl.col("rank_prev").mean().alias("prev_avg"),
        pl.col("rank_prev").median().alias("prev_median"),
        (pl.col("rank_prev").is_null() | (pl.col("rank_prev") > TOP)).sum().alias("new_year"),
        pl.col("rank_prev").is_null().sum().alias("prev_unranked"),
        pl.col("rank_next").mean().alias("next_avg"),
        (pl.col("rank_next").is_null() | (pl.col("rank_next") > TOP)).sum().alias("out_year"),
        pl.col("in_prev").is_null().sum().alias("new_week"),
        pl.col("age").mean().alias("age_avg"),
        pl.col("age").min().alias("age_min"),
        pl.col("wk_before").mean().alias("exp_avg"),
        pl.col("ioc").n_unique().alias("countries"),
        pl.col("id").sort_by("rank").alias("members"),
    ).join(has_next, on="i").sort("i"))
    first_i = int(agg["i"][0])

    def series(col: str, digits: int = 2, need_next: bool = False, need_prev: bool = False) -> list:
        out = []
        for row in agg.select("i", col, "ok").iter_rows():
            i, v, ok = row
            if v is None or (need_next and not ok) or (need_prev and i == first_i):
                out.append(None)
            else:
                out.append(round(float(v), digits))
        return out

    # earliest list with a full year of history behind it
    t0 = ex_dates[0].toordinal() + YEAR
    prev_ok = [d.toordinal() >= t0 for d in ex_dates]
    metrics = {
        "prev_avg": ("Avg rank a year earlier", "rank", "Average rank, 52 weeks earlier, of this week’s top 10 (unranked then: left out).", series("prev_avg")),
        "prev_median": ("Median rank a year earlier", "rank", "Median rank, 52 weeks earlier, of this week’s top 10.", series("prev_median")),
        "next_avg": ("Avg rank a year later", "rank", "Where this week’s top 10 are ranked 52 weeks on, on average. Ends a year before the data does.", series("next_avg", need_next=True)),
        "new_year": ("New vs a year earlier", "players", "How many of this week’s top 10 were not in the top 10 52 weeks earlier (0–10).", series("new_year", 0)),
        "out_year": ("Gone a year later", "players", "How many of this week’s top 10 are out of it 52 weeks on (0–10).", series("out_year", 0, need_next=True)),
        "new_week": ("Changes from previous list", "players", "Players in this top 10 who were not in the previous list’s top 10.", series("new_week", 0, need_prev=True)),
        "age_avg": ("Average age", "years", "Mean age of the top 10 on the list date.", series("age_avg")),
        "age_min": ("Youngest in top 10", "years", "Age of the youngest top-10 player.", series("age_min")),
        "exp_avg": ("Avg weeks already in top 10", "weeks", "Mean number of weeks each member had already spent in the top 10 before this list.", series("exp_avg", 1)),
        "countries": ("Countries represented", "countries", "Distinct nations among the top 10.", series("countries", 0)),
    }
    for k in ("prev_avg", "prev_median", "new_year"):  # year-earlier metrics need a year of history
        metrics[k] = (*metrics[k][:3], [v if ok else None for v, ok in zip(metrics[k][3], prev_ok)])

    n_lists = len(ex_dates)
    by_i = {int(i): m for i, m in agg.select("i", "members").iter_rows()}
    members = [by_i.get(i, []) for i in range(n_lists)]
    names = dict(lists.filter(pl.col("rank") <= TOP).select("id", "name").unique("id").iter_rows())
    out = {
        "generated": date.today().isoformat(),
        "source": "Tennismylife TML-Rankings-Database (official lists before 1985, weekly from 1985) + TML-Database bios",
        "dates": ex["dates"],
        "members": members,
        "names": names,
        "metrics": {k: {"label": a, "short": SHORT[k], "unit": u, "desc": d, "values": v} for k, (a, u, d, v) in metrics.items()},
        "checks": {
            "lists": n_lists,
            "lists_with_full_top10": int((agg["n"] == TOP).sum()),
            "top10_players": len(names),
            "members_missing_dob": int(top.filter(pl.col("dob").is_null())["id"].n_unique()),
        },
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps(out["checks"]))
    print(f"{os.path.getsize(out_path) / 1e3:.0f} kB -> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:5])
