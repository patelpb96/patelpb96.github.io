#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["polars>=1.0", "pyarrow>=15"]
# ///
"""Update the RuneScape alchemy dashboard data under public/rs-alchemy/data.

Sources
-------
- Item metadata dump: https://chisel.weirdgloop.org/gazproj/gazbot/rs_dump.json
- Price points:       https://api.weirdgloop.org/exchange/history/rs/last90d?id=<id>
- Current quotes:     https://api.weirdgloop.org/exchange/history/rs/latest?id=<id|id|...>

Data model (reverse-engineered 2026-08-20 from the existing export)
-------------------------------------------------------------------
history/part-NNN.parquet : one table of daily rows {item_id, t, price, volume,
                    profit, roi}, sharded by item_id % 256 (see rs_alchemy_table.py).
                    One row per UTC date = the LAST API point of that date.
                    profit = highalch - price - nature_price(date)
                    roi    = profit / (price + nature_price(date))
latest.json       : per item the last daily row + full point timestamp,
                    nature_price, alch_profit, alch_roi (full precision),
                    profit_per_limit; sorted by alch_profit desc.
summary/<w>.json  : aggregates over rows with t > anchor_date - N days,
                    N in {all, 366, 182, 91, 30, 7, 1}; anchor = global max date.
                    Sorted by profit_last desc.
items.json        : dump fields {item_id, name, value, highalch, lowalch, limit,
                    members, examine}, sorted by item_id.
All JSON: default separators, ensure_ascii, no trailing newline.

Usage
-----
    uv run tools/update_rs_alchemy.py              # full update
    uv run tools/update_rs_alchemy.py --validate   # no network: rebuild outputs
                                                   # from existing histories and
                                                   # diff against current files
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import polars as pl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rs_alchemy_table import nature_price_on, nature_series, read_table, write_table  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "rs-alchemy", "data")
HISTORY = os.path.join(DATA, "history")

DUMP_URL = "https://chisel.weirdgloop.org/gazproj/gazbot/rs_dump.json"
API_BASE = "https://api.weirdgloop.org"
UA = "patelpb96.github.io data updater (personal site; github.com/patelpb96)"
NATURE_ID = 561
WINDOWS = {  # summary name -> rows with t > anchor - N days (None = all rows)
    "all": None,
    "last_1y": 366,
    "last_6m": 182,
    "last_3m": 91,
    "last_1m": 30,
    "last_1w": 7,
    "last_1d": 1,
}
SUMMARY_ORDER = ["all", "last_1y", "last_6m", "last_3m", "last_1m", "last_1w", "last_1d"]
LATEST_BATCH = 100
WORKERS = 5          # the API 429s above ~6-8 concurrent per IP
RETRIES = 4
POINTS_CACHE = os.path.join(DATA, "_update_points_cache.json")


# --------------------------------------------------------------------------- io

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:  # default separators, no newline
        json.dump(obj, f)
    os.replace(tmp, path)


def http_json(url, timeout=90):
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:  # URLError, HTTPError, TimeoutError, JSONDecodeError
            last = e
            wait = 2 * attempt
            print(f"    warn: {url[:90]}.. attempt {attempt}/{RETRIES}: {e}; sleep {wait}s",
                  file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"GET failed after {RETRIES} tries: {url} ({last})")


# ------------------------------------------------------------- history utilities

def make_row(d, price, volume, highalch, nature):
    profit = (highalch - price - nature) if (highalch is not None and nature is not None) else None
    if profit is None or price is None:
        roi = None
    else:
        denom = price + nature
        roi = round(profit / denom, 5) if denom else None
    return {"t": d, "price": price, "volume": volume, "profit": profit, "roi": roi}


# ------------------------------------------------------------------ aggregation

def with_nature(df, nature_dates, nature_prices):
    """Add _nat = nature_price_on(t) per row (looked up once per distinct date)."""
    dates = sorted(set(df["t"].to_list()))
    nat = pl.DataFrame({"t": dates, "_nat": [nature_price_on(nature_dates, nature_prices, d) for d in dates]},
                       schema={"t": pl.Utf8, "_nat": pl.Int64})
    return df.join(nat, on="t", how="left", maintain_order="left")


def rebuild_summaries(items_by_id, hist, anchor, nature_dates, nature_prices, proc_order):
    """hist: table frame (item_id, t, price, volume, profit, _seq). Returns {window: [rows sorted]}.

    One summary row per item over rows with t > anchor - N days (rows may include dup dates).
    roi_mean is the mean of FULL-PRECISION daily roi (profit/(price+nature)), not of the
    5dp-rounded stored values. Sort: profit_last desc, ties keep proc_order (latest.json order).
    """
    order = pl.DataFrame({"item_id": proc_order, "_ord": range(len(proc_order))}, schema={"item_id": pl.Int32, "_ord": pl.Int64})
    info = pl.DataFrame([{k: items_by_id[i][k] for k in ("item_id", "name", "highalch", "limit", "members")}
                         for i in proc_order if i in items_by_id],
                        schema={"item_id": pl.Int32, "name": pl.Utf8, "highalch": pl.Int64, "limit": pl.Int64, "members": pl.Boolean})
    h = with_nature(hist.join(order, on="item_id", how="inner"), nature_dates, nature_prices)
    valid = pl.col("price").is_not_null() & pl.col("profit").is_not_null() & pl.col("_nat").is_not_null() & ((pl.col("price") + pl.col("_nat")) != 0)
    h = h.with_columns(pl.when(valid).then(pl.col("profit") / (pl.col("price") + pl.col("_nat"))).otherwise(None).alias("_roi"))
    out = {}
    for name, ndays in WINDOWS.items():
        w = h if ndays is None else h.filter(pl.col("t") > (anchor - timedelta(days=ndays)).isoformat())
        agg = (w.sort("_seq").group_by("item_id", maintain_order=True).agg(
            pl.len().alias("n_days"),
            pl.col("price").first().alias("price_first"),
            pl.col("price").last().alias("price_last"),
            pl.col("price").min().alias("price_min"),
            pl.col("price").max().alias("price_max"),
            pl.col("price").mean().alias("price_mean"),
            pl.col("volume").mean().alias("volume_mean"),
            pl.when(pl.col("volume").count() > 0).then(pl.col("volume").sum()).otherwise(None).alias("volume_total"),
            pl.col("profit").last().alias("profit_last"),
            pl.col("profit").mean().alias("profit_mean"),
            pl.col("profit").max().alias("profit_max"),
            pl.col("_roi").mean().alias("roi_mean"),
            (pl.col("profit") > 0).sum().cast(pl.Int64).alias("days_profitable"),
            pl.col("_ord").first(),
        ).with_columns((pl.col("price_last") - pl.col("price_first")).alias("price_change"))
         .with_columns(pl.when(pl.col("price_change").is_not_null() & pl.col("price_first").is_not_null() & (pl.col("price_first") != 0))
                       .then(pl.col("price_change") / pl.col("price_first")).otherwise(None).alias("price_change_frac"))
         .join(info, on="item_id", how="inner")
         .sort([pl.col("profit_last").is_null(), -pl.col("profit_last").fill_null(0), "_ord"]))
        out[name] = agg.select("item_id", "name", "highalch", "limit", "members", "n_days", "price_first", "price_last",
                               "price_min", "price_max", "price_mean", "volume_mean", "volume_total", "profit_last",
                               "profit_mean", "profit_max", "roi_mean", "days_profitable", "price_change",
                               "price_change_frac").to_dicts()
    return out


def rebuild_latest(items_by_id, last_rows, last_ts, nature_dates, nature_prices, proc_order):
    """last_rows: {item_id: last stored row}. Stable sort by alch_profit desc over proc_order."""
    rows = []
    for item_id in proc_order:
        lastrow = last_rows.get(item_id)
        item = items_by_id.get(item_id)
        if item is None or lastrow is None:
            continue
        nature = nature_price_on(nature_dates, nature_prices, lastrow["t"])
        price = lastrow["price"]
        high = item["highalch"]
        profit = (high - price - nature) if (high is not None and price is not None and nature is not None) else None
        denom = (price + nature) if (price is not None and nature is not None) else None
        roi = (profit / denom) if (profit is not None and denom) else None
        rows.append({
            "item_id": item_id,
            "name": item["name"],
            "timestamp": last_ts.get(item_id, lastrow["t"] + "T00:00:00"),
            "price": price,
            "volume": lastrow["volume"],
            "highalch": high,
            "lowalch": item["lowalch"],
            "limit": item["limit"],
            "members": item["members"],
            "nature_price": nature,
            "alch_profit": profit,
            "alch_roi": roi,
            "profit_per_limit": (profit * item["limit"]) if (profit is not None and item["limit"] is not None) else None,
        })
    rows.sort(key=lambda r: (r["alch_profit"] is None, -(r["alch_profit"] or 0)))
    return rows


# ----------------------------------------------------------------------- update

def fetch_points(item_id):
    """last90d points for one item: list of (ts_ms, price, volume)."""
    url = f"{API_BASE}/exchange/history/rs/last90d?id={item_id}"
    d = http_json(url)
    pts = d.get(str(item_id)) or []
    return item_id, [(int(p["timestamp"]), p.get("price"), p.get("volume")) for p in pts]


def fetch_points_safe(item_id):
    try:
        return fetch_points(item_id)
    except Exception as e:
        print(f"    ERROR fetching {item_id}: {e}", file=sys.stderr)
        return item_id, None


def fetch_latest_quotes(ids):
    """Batched current quotes. Returns {item_id: (ts_ms, price, volume)}."""
    out = {}
    for i in range(0, len(ids), LATEST_BATCH):
        chunk = ids[i : i + LATEST_BATCH]
        url = f"{API_BASE}/exchange/history/rs/latest?id={'|'.join(map(str, chunk))}"
        d = http_json(url)
        if not isinstance(d, dict) or d.get("success") is False:
            continue
        for k, v in d.items():
            if not isinstance(v, dict) or "timestamp" not in v:
                continue
            ts = datetime.fromisoformat(v["timestamp"].replace("Z", "+00:00"))
            out[int(k)] = (int(ts.timestamp() * 1000), v.get("price"), v.get("volume"))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--validate", action="store_true",
                    help="offline: rebuild outputs from current histories and diff")
    ap.add_argument("--use-cache", action="store_true",
                    help="reuse points fetched by a previous run (skip all network)")
    args = ap.parse_args()

    old_items = load_json(os.path.join(DATA, "items.json"))
    old_latest = load_json(os.path.join(DATA, "latest.json"))
    old_meta = load_json(os.path.join(DATA, "meta.json"))
    items_by_id = {r["item_id"]: r for r in old_items}
    last_ts = {r["item_id"]: r["timestamp"] for r in old_latest}
    last_ts_ms = {}
    for iid, ts in last_ts.items():
        try:
            last_ts_ms[iid] = int(datetime.fromisoformat(ts).replace(
                tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            last_ts_ms[iid] = 0

    print("loading history table ...", flush=True)
    t0 = time.time()
    hist = read_table().with_row_index("_seq")
    table_ids = hist["item_id"].unique().to_list()
    print(f"loaded {hist.height:,} rows for {len(table_ids)} items in {time.time()-t0:.0f}s", flush=True)

    # ---------------------------------------------------------- fetch new data
    new_points = {}   # item_id -> [(ts_ms, price, volume), ...] strictly new
    changed = set()
    failures = []
    n_failed = 0
    dump_order = None  # item ids in chisel dump order (tie-break authority)
    if args.use_cache and not args.validate:
        cache = load_json(POINTS_CACHE)
        new_points = {int(k): [tuple(p) for p in v]
                      for k, v in cache["new_points"].items()}
        items_by_id = {int(k): v for k, v in cache["items_by_id"].items()}
        dump_order = cache["dump_order"]
        print(f"cache: {len(new_points)} items with new points "
              f"(fetched {cache.get('fetched_utc', '?')})", flush=True)
    if not args.validate and not args.use_cache:
        print("fetching item dump ...", flush=True)
        dump = http_json(DUMP_URL)
        new_items = []
        for k, e in dump.items():
            if not isinstance(e, dict):  # skip %UPDATE_DETECTED% etc. metadata
                continue
            new_items.append({
                "item_id": int(e.get("id", k)),
                "name": e.get("name"),
                "value": e.get("value"),
                "highalch": e.get("highalch"),
                "lowalch": e.get("lowalch"),
                "limit": e.get("limit"),
                "members": bool(e.get("members")),
                "examine": e.get("examine"),
            })
        new_items.sort(key=lambda r: r["item_id"])
        if len(new_items) >= 6000:  # sanity: never clobber with a partial dump
            dump_order = [int(e.get("id", k)) for k, e in dump.items()
                          if isinstance(e, dict)]
            items_by_id = {r["item_id"]: r for r in new_items}
            write_json(os.path.join(DATA, "items.json"), new_items)
            print(f"items.json: {len(new_items)} items")
        else:
            print(f"dump looked partial ({len(new_items)} items); keeping old items.json",
                  file=sys.stderr)

        ids = sorted(set(items_by_id) | set(table_ids))
        print(f"fetching last90d for {len(ids)} items ...", flush=True)
        t0 = time.time()
        done = 0
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for item_id, pts in ex.map(fetch_points_safe, ids):
                done += 1
                if done % 500 == 0:
                    print(f"  {done}/{len(ids)} ({time.time()-t0:.0f}s)", flush=True)
                if pts is None:
                    failures.append((item_id, "fetch failed"))
                    continue
                cutoff = last_ts_ms.get(item_id, 0)
                fresh = [p for p in pts if p[0] > cutoff]
                if fresh:
                    new_points.setdefault(item_id, []).extend(fresh)
        print(f"last90d done in {time.time()-t0:.0f}s", flush=True)

        print("fetching latest quotes ...", flush=True)
        quotes = fetch_latest_quotes(ids)
        for item_id, (ts, price, volume) in quotes.items():
            if ts > last_ts_ms.get(item_id, 0):
                new_points.setdefault(item_id, []).append((ts, price, volume))
        print(f"quotes for {len(quotes)} items", flush=True)

        # crash-safe cache: the apply phase can be re-run with --use-cache
        write_json(POINTS_CACHE, {
            "fetched_utc": datetime.now(timezone.utc).isoformat(),
            "new_points": {str(k): v for k, v in new_points.items()},
            "items_by_id": {str(k): v for k, v in items_by_id.items()},
            "dump_order": dump_order,
        })
        print(f"points cached ({len(new_points)} items)", flush=True)

    # ------------------------------------------------- apply updates to history
    # Same rules as the old per-file append: one row per UTC date (the last point of the
    # day); a new point on the item's last stored date replaces that row; older dates
    # are skipped. The nature rune goes first so every other item's profit uses its
    # fresh series.
    last_idx = hist.group_by("item_id").agg(pl.col("_seq").max()).to_dict(as_series=False)
    last_rows = {i: hist.row(int(q), named=True) for i, q in zip(last_idx["item_id"], last_idx["_seq"])}
    added = []          # new rows, in order
    replaced = set()    # _seq of last rows superseded by a same-date point

    def apply_item(item_id, nature_dates, nature_prices):
        """Queue new rows for one item. Returns True if anything changed."""
        pts = new_points.get(item_id)
        item = items_by_id.get(item_id)
        if not pts or item is None:
            return False
        high = item["highalch"]
        by_date = {}
        for ts, price, volume in pts:
            d = datetime.fromtimestamp(ts / 1000, timezone.utc).date().isoformat()
            if d not in by_date or ts > by_date[d][0]:
                by_date[d] = (ts, price, volume)
        last = last_rows.get(item_id)
        existing_last = last["t"] if last else None
        changed_here = False
        for d in sorted(by_date):
            ts, price, volume = by_date[d]
            nature = price if item_id == NATURE_ID else nature_price_on(nature_dates, nature_prices, d)
            row = make_row(d, int(price) if price is not None else None,
                           float(volume) if volume is not None else None, high, nature)
            if existing_last is not None and d < existing_last:
                continue  # already have a newer-or-equal last date; skip stale
            stamp = datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
            if d == existing_last:
                old = {k: last[k] for k in ("t", "price", "volume", "profit", "roi")}
                if old != row:
                    if last.get("_seq") is not None:
                        replaced.add(last["_seq"])
                    else:
                        added.remove(last)
                    row = {"item_id": item_id, **row}
                    added.append(row)
                    last_rows[item_id] = last = row
                    changed_here = True
                    last_ts[item_id] = stamp
            else:
                row = {"item_id": item_id, **row}
                added.append(row)
                last_rows[item_id] = last = row
                existing_last = d
                changed_here = True
                last_ts[item_id] = stamp
        return changed_here

    nature_dates, nature_prices = nature_series(hist)
    if not args.validate:
        if apply_item(NATURE_ID, nature_dates, nature_prices):
            changed.add(NATURE_ID)
        # reload the nature series as the old code re-read its file: stored rows (minus a replaced
        # last row) followed by the rows just added
        nat_rows = hist.filter((pl.col("item_id") == NATURE_ID) & ~pl.col("_seq").is_in(list(replaced)))
        nature_dates = nat_rows["t"].to_list() + [r["t"] for r in added if r["item_id"] == NATURE_ID]
        nature_prices = nat_rows["price"].to_list() + [r["price"] for r in added if r["item_id"] == NATURE_ID]

        todo = sorted(i for i in new_points if i != NATURE_ID)
        print(f"merging new points for {len(todo)} items ...", flush=True)
        for n, item_id in enumerate(todo, 1):
            try:
                if apply_item(item_id, nature_dates, nature_prices):
                    changed.add(item_id)
            except Exception as e:
                failures.append((item_id, str(e)))
                print(f"    ERROR item {item_id}: {e}", file=sys.stderr)
            if n % 1000 == 0:
                print(f"  {n}/{len(todo)}", flush=True)
        n_failed = len(failures)
        if added or replaced:
            new = pl.DataFrame(added, schema={"item_id": pl.Int32, "t": pl.Utf8, "price": pl.Int64, "volume": pl.Float64,
                                              "profit": pl.Int64, "roi": pl.Float64})
            new = new.with_row_index("_seq", offset=hist.height).with_columns(pl.col("_seq").cast(hist["_seq"].dtype))
            hist = (pl.concat([hist.filter(~pl.col("_seq").is_in(list(replaced))), new.select(hist.columns)])
                      .sort("item_id", "_seq"))
            hist = hist.drop("_seq").with_row_index("_seq")
            write_table(hist.drop("_seq"))
        print(f"items changed: {len(changed)} ({len(added)} rows added, {len(replaced)} replaced); "
              f"failures: {n_failed}", flush=True)
        last_rows = {r["item_id"]: r for r in hist.group_by("item_id").agg(pl.all().sort_by("_seq").last()).to_dicts()}

    # ------------------------------------------------- rebuild views
    all_ids = hist["item_id"].unique(maintain_order=True).to_list()
    anchor = date.fromisoformat(hist["t"].max())
    print(f"anchor date: {anchor}", flush=True)

    # processing order: dump order when fresh, else previous latest.json order;
    # any id with a history but missing from that order appends at the end.
    if dump_order is None:
        dump_order = [r["item_id"] for r in old_latest]
    proc_order = dump_order + [i for i in all_ids if i not in set(dump_order)]

    latest_rows = rebuild_latest(items_by_id, last_rows, last_ts,
                                 nature_dates, nature_prices, proc_order)
    latest_order = [r["item_id"] for r in latest_rows]
    summaries = rebuild_summaries(items_by_id, hist, anchor,
                                  nature_dates, nature_prices, latest_order)

    if args.validate:
        ok = True

        def close(a, b):
            """Structural equality with float tolerance (numpy vs naive mean dust)."""
            if isinstance(a, float) and isinstance(b, float):
                return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
            if isinstance(a, list) and isinstance(b, list):
                return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
            if isinstance(a, dict) and isinstance(b, dict):
                return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
            return a == b

        # latest: compare ignoring timestamp (full ts not stored in history rows)
        def strip_ts(rows):
            return [{k: v for k, v in r.items() if k != "timestamp"} for r in rows]
        if not close(strip_ts(latest_rows), strip_ts(old_latest)):
            a, b = strip_ts(old_latest), strip_ts(latest_rows)
            bad = [i for i in range(min(len(a), len(b))) if not close(a[i], b[i])][:3]
            print(f"latest.json MISMATCH in {len(bad)}+ rows; first idx {bad}", flush=True)
            for i in bad[:1]:
                print("old:", a[i], "\nnew:", b[i])
            ok = False
        else:
            print("latest.json reproduced (ignoring timestamps) OK")
        for name in SUMMARY_ORDER:
            old = load_json(os.path.join(DATA, "summary", f"{name}.json"))
            if not close(old, summaries[name]):
                bad = [i for i in range(min(len(old), len(summaries[name])))
                       if not close(old[i], summaries[name][i])][:3]
                print(f"summary/{name}.json MISMATCH (rows {len(old)} vs "
                      f"{len(summaries[name])}); first bad idx {bad}", flush=True)
                if bad:
                    i = bad[0]
                    print("old:", old[i], "\nnew:", summaries[name][i])
                ok = False
            else:
                print(f"summary/{name}.json reproduced OK")
        sys.exit(0 if ok else 1)

    # ------------------------------------------------------------- write views
    write_json(os.path.join(DATA, "latest.json"), latest_rows)
    for name in SUMMARY_ORDER:
        write_json(os.path.join(DATA, "summary", f"{name}.json"), summaries[name])
    write_json(os.path.join(HISTORY, "index.json"), sorted(all_ids))
    print("latest.json + summaries + history/index.json written", flush=True)

    max_ts = max(last_ts.values()) if last_ts else old_meta["last_timestamp"]
    meta = dict(old_meta)
    meta["created_utc"] = datetime.now(timezone.utc).isoformat()
    meta["last_timestamp"] = max_ts.replace("T", " ")
    meta["n_items"] = len(items_by_id)
    meta["n_history_items"] = len(all_ids)
    meta["n_items_requested"] = len(items_by_id)
    meta["n_items_with_data"] = len(all_ids)
    meta["history_table"] = {"format": "parquet", "path": "history/part-NNN.parquet", "shards": 256,
                             "columns": ["item_id", "day", "price", "volume", "adj", "roi"]}
    meta["n_failed"] = n_failed
    write_json(os.path.join(DATA, "meta.json"), meta)
    print(f"meta.json written (last_timestamp {meta['last_timestamp']})", flush=True)
    if os.path.exists(POINTS_CACHE):
        os.remove(POINTS_CACHE)  # fully applied; next run fetches fresh
    if failures:
        print("failed items:", failures[:20], file=sys.stderr)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
