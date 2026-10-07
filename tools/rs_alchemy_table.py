# /// script
# requires-python = ">=3.10"
# dependencies = ["polars>=1.0", "pyarrow>=15"]
# ///
"""Price-history table for the RuneScape alchemy dashboard.

All item histories live in one long table (one row per item per day), split into
SHARDS Parquet files by `item_id % SHARDS` so the browser fetches ~200 kB to show one
item. This replaces ~7,300 per-item JSON files (2.5 GB), which broke `npm run deploy`
on Windows (spawn ENAMETOOLONG) and bloated the site.

    public/rs-alchemy/data/history/part-NNN.parquet

Columns (rows keep their original order within an item; a few dates repeat):
    item_id  int32
    day      int32   days since 1970-01-01 (UTC date of the item's last point that day)
    price    int64
    volume   int64   nullable
    adj      int64   nullable; = -(price + profit), i.e. nature price - high alch.
                     Stored instead of profit because it barely changes day to day
                     (delta-encodes to almost nothing). profit = -(price + adj).
    roi      float64 nullable; only where the stored roi differs from
                     round(profit / (price + nature_price_on(day)), 5); NaN marks a
                     stored null where a value would otherwise be derived

Integer columns are DELTA_BINARY_PACKED, compression snappy (readable by hyparquet
without extra codecs).

One-off conversion from the old per-item JSON files:
    uv run tools/rs_alchemy_table.py --migrate
"""
from __future__ import annotations

import glob
import os
import sys
from bisect import bisect_right
from datetime import date

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "rs-alchemy", "data")
HISTORY = os.path.join(DATA, "history")
SHARDS = 256
NATURE_ID = 561
EPOCH = date(1970, 1, 1).toordinal()


def shard_path(k: int) -> str:
    return os.path.join(HISTORY, f"part-{k:03d}.parquet")


def nature_price_on(nature_dates, nature_prices, d):
    """Nature rune price on ISO date d (ffill from earlier dates; first price before the series)."""
    i = bisect_right(nature_dates, d) - 1
    if i < 0:
        return nature_prices[0] if nature_prices else None
    return nature_prices[i]


def nature_series(df: pl.DataFrame):
    """(dates, prices) of the nature rune from a history frame, in stored row order."""
    n = df.filter(pl.col("item_id") == NATURE_ID)
    return n["t"].to_list(), n["price"].to_list()


def read_table() -> pl.DataFrame:
    """All shards -> item_id, t (ISO str), price, volume (f64), profit, roi (stored or derived), in stored order."""
    files = sorted(glob.glob(os.path.join(HISTORY, "part-*.parquet")))
    if not files:
        raise FileNotFoundError(f"no history shards in {HISTORY} (run --migrate first?)")
    df = pl.concat([pl.read_parquet(f) for f in files]).sort("item_id", maintain_order=True)
    df = df.with_columns(
        (pl.lit(date(1970, 1, 1)) + pl.duration(days=pl.col("day"))).dt.strftime("%Y-%m-%d").alias("t"),
        pl.col("volume").cast(pl.Float64),
        (-(pl.col("price") + pl.col("adj"))).alias("profit"),
    )
    nd, np_ = nature_series(df)
    nat = pl.DataFrame({"t": sorted(set(df["t"].to_list()))}).with_columns(
        pl.col("t").map_elements(lambda d: nature_price_on(nd, np_, d), return_dtype=pl.Int64).alias("_nat"))
    df = df.join(nat, on="t", how="left", maintain_order="left")
    derived = (pl.col("profit") / (pl.col("price") + pl.col("_nat"))).round(5)
    df = df.with_columns(
        pl.when(pl.col("roi").is_nan()).then(None)
        .when(pl.col("roi").is_not_null()).then(pl.col("roi"))
        .when(pl.col("profit").is_null() | ((pl.col("price") + pl.col("_nat")) == 0)).then(None)
        .otherwise(derived).alias("roi"))
    return df.select("item_id", "t", "price", "volume", "profit", "roi")


def write_table(df: pl.DataFrame) -> None:
    """df: item_id, t (ISO str), price, volume, profit, roi; rows already in final order per item."""
    os.makedirs(HISTORY, exist_ok=True)
    nd, np_ = nature_series(df)
    nat = pl.DataFrame({"t": sorted(set(df["t"].to_list()))}).with_columns(
        pl.col("t").map_elements(lambda d: nature_price_on(nd, np_, d), return_dtype=pl.Int64).alias("_nat"))
    out = df.join(nat, on="t", how="left", maintain_order="left").with_columns(
        (pl.col("t").str.strptime(pl.Date, "%Y-%m-%d").cast(pl.Int32)).alias("day"),
        pl.col("volume").round().cast(pl.Int64),
        (-(pl.col("price") + pl.col("profit"))).alias("adj"),
        (pl.col("profit") / (pl.col("price") + pl.col("_nat"))).round(5).alias("_derived"),
    ).with_columns(  # keep roi only where it can't be re-derived
        pl.when(pl.col("roi").is_null() & pl.col("_derived").is_not_null()).then(float("nan"))
        .when(pl.col("roi").is_not_null() & ~pl.col("roi").eq_missing(pl.col("_derived"))).then(pl.col("roi"))
        .otherwise(None).alias("roi"),
        (pl.col("item_id") % SHARDS).alias("_shard"),
    )
    keep = {shard_path(k) for k in range(SHARDS)}
    for f in glob.glob(os.path.join(HISTORY, "part-*.parquet")):
        if f not in keep:
            os.remove(f)
    for (k,), part in out.group_by("_shard", maintain_order=True):
        part = part.sort("item_id", maintain_order=True)  # stable: per-item row order is preserved
        tbl = pa.table({
            "item_id": pa.array(part["item_id"].to_list(), pa.int32()),
            "day": pa.array(part["day"].to_list(), pa.int32()),
            "price": pa.array(part["price"].to_list(), pa.int64()),
            "volume": pa.array(part["volume"].to_list(), pa.int64()),
            "adj": pa.array(part["adj"].to_list(), pa.int64()),
            "roi": pa.array(part["roi"].to_list(), pa.float64()),
        })
        tmp = shard_path(k) + ".tmp"
        pq.write_table(tbl, tmp, compression="snappy", use_dictionary=["item_id"], write_statistics=False,
                       column_encoding={c: "DELTA_BINARY_PACKED" for c in ("day", "price", "volume", "adj")})
        os.replace(tmp, shard_path(k))
    # shards with no rows (none today) would otherwise be missing: write empty tables
    for k in range(SHARDS):
        if not os.path.exists(shard_path(k)):
            pq.write_table(pa.table({c: pa.array([], t) for c, t in (("item_id", pa.int32()), ("day", pa.int32()), ("price", pa.int64()),
                                                                    ("volume", pa.int64()), ("adj", pa.int64()), ("roi", pa.float64()))}),
                           shard_path(k), compression="snappy")


def migrate() -> None:
    """Old history/<id>.json files -> table shards; verifies a lossless round trip, then deletes the JSON files."""
    import orjson  # only needed for the one-off migration
    files = [f for f in glob.glob(os.path.join(HISTORY, "*.json")) if os.path.basename(f)[:-5].isdigit()]
    files.sort(key=lambda f: int(os.path.basename(f)[:-5]))
    cols = {k: [] for k in ("item_id", "t", "price", "volume", "profit", "roi")}
    for f in files:
        iid = int(os.path.basename(f)[:-5])
        rows = orjson.loads(open(f, "rb").read())
        cols["item_id"] += [iid] * len(rows)
        for k in ("t", "price", "volume", "profit", "roi"):
            cols[k] += [r[k] for r in rows]
    src = pl.DataFrame(cols, schema={"item_id": pl.Int32, "t": pl.Utf8, "price": pl.Int64, "volume": pl.Float64,
                                     "profit": pl.Int64, "roi": pl.Float64})
    print(f"read {len(files)} files, {src.height:,} rows", flush=True)
    write_table(src)
    back = read_table()
    a = src.sort("item_id", maintain_order=True)
    if a.shape != back.shape or not a.equals(back):
        diff = a.with_row_index().join(back.with_row_index(), on="index", suffix="_new")
        for c in ("item_id", "t", "price", "volume", "profit", "roi"):
            bad = diff.filter(~pl.col(c).eq_missing(pl.col(c + "_new")))
            if bad.height:
                print(f"MISMATCH in {c}: {bad.height} rows, e.g. {bad.head(3).to_dicts()}")
        sys.exit("round trip failed; JSON files kept")
    size = sum(os.path.getsize(shard_path(k)) for k in range(SHARDS))
    print(f"round trip exact: {back.height:,} rows -> {SHARDS} shards, {size / 1e6:.1f} MB", flush=True)
    for f in files:
        os.remove(f)
    print(f"removed {len(files)} per-item JSON files", flush=True)


if __name__ == "__main__":
    if "--migrate" in sys.argv:
        migrate()
    else:
        print(__doc__)
