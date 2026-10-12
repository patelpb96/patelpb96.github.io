"""Refresh live RS alchemy prices -> s3://<BUCKET>/live/rs-alchemy/{latest,meta}.json.

Ports the latest.json part of tools/update_rs_alchemy.py (stdlib + boto3 only):
  * base rows = the static rs-alchemy/data/latest.json (item metadata, previous
    quote per item, and the processing order used as the sort tie-break);
  * current quotes from /exchange/history/rs/latest in batches of LATEST_BATCH ids;
  * a quote replaces an item's row when its timestamp is newer and its UTC date is not
    older than the stored row's date (same rules as apply_item);
  * nature_price = nature rune price on the row's UTC date (forward-filled daily series
    built from the base row, /last90d?id=561 and the current 561 quote), i.e. today's
    nature quote for every item quoted today; rows older than the series keep theirs;
  * alch_profit = highalch - price - nature, alch_roi = profit / (price + nature)
    (full precision), profit_per_limit = profit * limit; None-propagation as rebuild_latest;
  * stable sort by alch_profit desc (None last) over the base order;
  * JSON written with default separators, ensure_ascii, no trailing newline.

Event: {"trigger": "button"|"schedule"|"manual", "token": <lock token if the trigger
already holds the lock>, "started_utc": ..., "prev_next_allowed_utc": ...}
"""
from __future__ import annotations

import json
import os
import time
import traceback
import urllib.request
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import state

API_BASE = "https://api.weirdgloop.org"
UA = "patelpb96.github.io data updater (personal site; github.com/patelpb96)"
NATURE_ID = 561
LATEST_BATCH = 100
WORKERS = int(os.environ.get("FETCH_CONCURRENCY", "4"))
RETRIES = 4
BASE_KEY = os.environ.get("BASE_KEY", "rs-alchemy/data/latest.json")


# --------------------------------------------------------------------- fetching

def http_json(url, deadline, timeout=20):
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:  # URLError, HTTPError (429/5xx), timeout, bad JSON
            last = e
            wait = 1.5 * 2 ** (attempt - 1)  # 1.5, 3, 6 s
            if attempt == RETRIES or time.monotonic() + wait + timeout > deadline:
                break
            print(f"warn: {url[:80]}.. attempt {attempt}/{RETRIES}: {e}; sleep {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"GET failed: {url[:80]}.. ({last})")


def ts_ms(iso_str):
    """'2026-10-11T21:01:51.000Z' or naive '2026-10-09T14:06:46' (UTC) -> epoch ms."""
    dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def ms_date(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat()


def ms_stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def fetch_quotes(ids, deadline):
    """Returns ({item_id: (ts_ms, price, volume)}, [failed ids])."""
    chunks = [ids[i:i + LATEST_BATCH] for i in range(0, len(ids), LATEST_BATCH)]

    def one(chunk):
        url = f"{API_BASE}/exchange/history/rs/latest?id={'|'.join(map(str, chunk))}"
        try:
            return chunk, http_json(url, deadline)
        except Exception as e:
            print(f"ERROR batch starting {chunk[0]}: {e}")
            return chunk, None

    out, failed = {}, []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for chunk, d in ex.map(one, chunks):
            if d is None:
                failed.extend(chunk)
                continue
            if not isinstance(d, dict) or d.get("success") is False:
                continue
            for k, v in d.items():
                if not isinstance(v, dict) or "timestamp" not in v:
                    continue
                out[int(k)] = (ts_ms(v["timestamp"]), v.get("price"), v.get("volume"))
    return out, failed


def fetch_nature_points(deadline):
    """last90d points of the nature rune: [(ts_ms, price)] (best effort)."""
    try:
        d = http_json(f"{API_BASE}/exchange/history/rs/last90d?id={NATURE_ID}", deadline)
        return [(int(p["timestamp"]), p.get("price")) for p in (d.get(str(NATURE_ID)) or [])]
    except Exception as e:
        print(f"warn: nature last90d unavailable: {e}")
        return []


# ---------------------------------------------------------------------- compute

def nature_series(base_nature_row, points, quote):
    """Daily (dates, prices): per UTC date the price of the latest point that day."""
    by_date = {}

    def add(ms, price):
        if price is None:
            return
        d = ms_date(ms)
        if d not in by_date or ms >= by_date[d][0]:
            by_date[d] = (ms, int(price))

    if base_nature_row and base_nature_row.get("price") is not None:
        add(ts_ms(base_nature_row["timestamp"]), base_nature_row["price"])
    for ms, price in points:
        add(ms, price)
    if quote:
        add(quote[0], quote[1])
    dates = sorted(by_date)
    return dates, [by_date[d][1] for d in dates]


def nature_price_on(dates, prices, d):
    i = bisect_right(dates, d) - 1
    if i < 0:
        return prices[0] if prices else None
    return prices[i]


def build_latest(base, quotes, nature_dates, nature_prices):
    """base: static latest.json rows (in processing order). Returns new sorted rows."""
    first_nat = nature_dates[0] if nature_dates else None
    rows = []
    for r in base:
        item_id = r["item_id"]
        stamp, price, volume = r["timestamp"], r["price"], r["volume"]
        day = stamp[:10]
        q = quotes.get(item_id)
        if q is not None and q[0] > ts_ms(stamp) and ms_date(q[0]) >= day:
            qd = ms_date(q[0])
            qprice = int(q[1]) if q[1] is not None else None
            qvol = float(q[2]) if q[2] is not None else None
            qnat = qprice if item_id == NATURE_ID else nature_price_on(nature_dates, nature_prices, qd)
            # same-day point identical to the stored row: the updater keeps the old timestamp
            if not (qd == day and qprice == price and qvol == volume and qnat == r["nature_price"]):
                stamp, price, volume, day = ms_stamp(q[0]), qprice, qvol, qd
        if first_nat is not None and day >= first_nat:
            nature = nature_price_on(nature_dates, nature_prices, day)
        else:
            nature = r["nature_price"]  # older than any series we have: keep the stored value
        high, limit = r["highalch"], r["limit"]
        profit = (high - price - nature) if (high is not None and price is not None and nature is not None) else None
        denom = (price + nature) if (price is not None and nature is not None) else None
        roi = (profit / denom) if (profit is not None and denom) else None
        rows.append({
            "item_id": item_id,
            "name": r["name"],
            "timestamp": stamp,
            "price": price,
            "volume": volume,
            "highalch": high,
            "lowalch": r["lowalch"],
            "limit": limit,
            "members": r["members"],
            "nature_price": nature,
            "alch_profit": profit,
            "alch_roi": roi,
            "profit_per_limit": (profit * limit) if (profit is not None and limit is not None) else None,
        })
    rows.sort(key=lambda x: (x["alch_profit"] is None, -(x["alch_profit"] or 0)))
    return rows


def refresh(deadline):
    base, _ = state.get_json(BASE_KEY)
    if not isinstance(base, list) or len(base) < 1000:
        raise RuntimeError(f"base {BASE_KEY} missing or too small")
    ids = [r["item_id"] for r in base]
    if NATURE_ID not in ids:
        raise RuntimeError("nature rune missing from base rows")
    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=1) as ex:  # overlaps with the quote batches
        nat_future = ex.submit(fetch_nature_points, deadline)
        quotes, failed = fetch_quotes(ids, deadline)
        nat_points = nat_future.result()
    print(json.dumps({"event": "fetched", "quotes": len(quotes), "failed": len(failed),
                      "nature_points": len(nat_points), "secs": round(time.monotonic() - t0, 1)}))
    if not quotes:
        raise RuntimeError(f"no quotes fetched ({len(failed)} ids failed)")
    base_nat = next(r for r in base if r["item_id"] == NATURE_ID)
    dates, prices = nature_series(base_nat, nat_points, quotes.get(NATURE_ID))
    rows = build_latest(base, quotes, dates, prices)
    return rows, len(failed)


# ---------------------------------------------------------------------- handler

def handler(event, context):
    event = event if isinstance(event, dict) else {}
    trigger = event.get("trigger") if event.get("trigger") in ("button", "schedule", "manual") else "manual"
    token = event.get("token")
    prev_meta = state.read_meta()
    if token:
        started = event.get("started_utc") or state.iso(state.now_utc())
        prev_next = event.get("prev_next_allowed_utc")
    else:  # schedule / manual invoke: take the lock ourselves
        ok, lock = state.acquire_lock(trigger)
        if not ok:
            print(json.dumps({"event": "skipped", "reason": "running", "lock": lock}))
            return {"status": "running", "started_utc": lock.get("started_utc")}
        token, started = lock["token"], lock["started_utc"]
        prev_next = prev_meta.get("next_allowed_utc")
        state.write_meta({**prev_meta, "status": "running", "started_utc": started, "error": None,
                          "trigger": trigger})

    # leave ~10 s to write results before the Lambda timeout
    remaining = context.get_remaining_time_in_millis() / 1000 if context else 110
    deadline = time.monotonic() + remaining - 10
    try:
        rows, n_failed = refresh(deadline)
        state.put_public_json(state.LATEST_KEY, json.dumps(rows).encode("ascii"))
        start_dt = state.parse_iso(started) or state.now_utc()
        meta = {
            "status": "idle",
            "updated_utc": state.iso(state.now_utc()),
            "started_utc": started,
            "next_allowed_utc": state.iso(start_dt + state.COOLDOWN),
            "n_items": len(rows),
            "n_failed": n_failed,
            "error": None,
            "trigger": trigger,
        }
        state.write_meta(meta)
        print(json.dumps({"event": "done", **meta}))
        return meta
    except Exception as e:
        traceback.print_exc()
        meta = {**prev_meta, "status": "error", "started_utc": started, "next_allowed_utc": prev_next,
                "error": f"{type(e).__name__}: {e}"[:300], "trigger": trigger}
        state.write_meta(meta)
        return meta
    finally:
        state.release_lock(token)
