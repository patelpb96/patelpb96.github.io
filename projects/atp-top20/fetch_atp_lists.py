"""Append ATP ranking lists newer than the TML weekly set, fetched from atptour.com.

    python fetch_atp_lists.py sources/TML-Rankings-Database [--check YYYY-MM-DD]

TML-Rankings-Database stopped updating in Jan 2026. This reads the list dates atptour.com offers,
fetches every list dated after the last one in `TML Rankings/<year>.csv`, and appends them in TML's
format (date,rank,name,id,points). Only lists ATP actually published are added (no filler weeks).
Re-running is safe: dates already present are skipped.

atptour.com sits behind a Cloudflare check, so pages are loaded with headless Chrome (--dump-dom).
Names come from TML-Database's ATP_Database.csv by player id where known, else from the profile slug.

--check DATE fetches a list TML already has and compares it row by row (parser sanity check).
"""
from __future__ import annotations

import csv
import glob
import html
import os
import re
import subprocess
import sys
import tempfile

CHROME = next((p for p in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                           r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                           "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
               if os.path.exists(p)), "chrome")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
URL = "https://www.atptour.com/en/rankings/singles?rankRange=0-5000&dateWeek={}"
PROFILE = os.path.join(tempfile.gettempdir(), "atp-fetch-chrome")

ROW = re.compile(r'<tr class="lower-row">(.*?)</tr>', re.S)
RANK = re.compile(r'class="rank[^"]*"[^>]*>\s*(\d+)T?\s*<')
PLAYER = re.compile(r'href="/en/players/([^/]+)/([a-z0-9]{4})/overview"')
POINTS = re.compile(r'rankings-breakdown\?team=singles">\s*([\d,]+)\s*<')
OPTION = re.compile(r'<option value="([^"]+)"[^>]*>(\d{4})\.(\d\d)\.(\d\d)</option>')


def fetch(date: str) -> str:
    for attempt in range(3):
        out = subprocess.run([CHROME, "--headless=new", "--disable-gpu", f"--user-data-dir={PROFILE}",
                              "--disable-blink-features=AutomationControlled", f"--user-agent={UA}",
                              "--virtual-time-budget=20000", "--dump-dom", URL.format(date)],
                             capture_output=True, timeout=180)
        page = out.stdout.decode("utf-8", "replace")
        if page.count('class="lower-row"') > 100:
            return page
        print(f"  {date}: no list in page (attempt {attempt + 1})", flush=True)
    raise RuntimeError(f"could not load the {date} list")


def parse(page: str):
    rows = []
    for tr in ROW.findall(page):
        r, p, pts = RANK.search(tr), PLAYER.search(tr), POINTS.search(tr)
        if not (r and p):
            continue
        rows.append((int(r.group(1)), p.group(2).upper(), p.group(1), int(pts.group(1).replace(",", "")) if pts else None))
    # the page renders the table twice (desktop + mobile layouts): keep one copy, after checking they agree
    starts = [i for i, row in enumerate(rows) if row[0] == 1 and (i == 0 or rows[i - 1][0] != 1)]
    if len(starts) > 1:
        first, second = rows[:starts[1]], rows[starts[1]:starts[2] if len(starts) > 2 else None]
        assert [x[:2] for x in first] == [x[:2] for x in second], "the page's two copies of the list differ"
        rows = first
    return rows


def week_dates(page: str):
    """ISO dates of every list in the page's week picker ('Current Week' resolved to its date)."""
    return sorted({f"{y}-{m}-{d}" for _, y, m, d in OPTION.findall(page)})


def main(repo: str, check: str | None = None):
    tml_dir = os.path.join(repo, "TML Rankings")
    db = os.path.join(os.path.dirname(os.path.abspath(repo)), "TML-Database", "ATP_Database.csv")
    names = {}
    if os.path.exists(db):
        with open(db, encoding="utf-8", errors="replace", newline="") as f:
            for row in csv.DictReader(f):
                if row.get("id") and row.get("player"):
                    names[row["id"].strip().upper()] = row["player"].strip()
    have = {}
    for fn in glob.glob(os.path.join(tml_dir, "*.csv")):
        with open(fn, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                if not re.fullmatch(r"\d{8}", row["date"] or ""):
                    continue  # some TML files repeat their header row mid-file
                have.setdefault(row["date"], []).append(row)
                names.setdefault(row["id"].upper(), row["name"])
    name_of = lambda pid, slug: names.get(pid) or " ".join(w.capitalize() for w in slug.split("-"))

    if check:
        rows = parse(fetch(check))
        old = [(int(r["rank"]), r["id"].upper()) for r in have[check.replace("-", "")]]
        new = [(rk, pid) for rk, pid, _, _ in rows]
        print("row-for-row identical:", old == new)
        old, new = set(old), set(new)
        print(f"{check}: TML {len(old)} rows, ATP {len(new)} rows, {len(old & new)} identical (rank, id)")
        return

    last = max(have)  # YYYYMMDD
    first = fetch("2026-01-19" if last < "20260119" else f"{last[:4]}-{last[4:6]}-{last[6:]}")
    todo = [d for d in week_dates(first) if d.replace("-", "") > last]
    print(f"TML ends {last}; {len(todo)} newer lists on atptour.com: {todo[0] if todo else '-'} .. {todo[-1] if todo else '-'}", flush=True)
    for d in todo:
        rows = parse(fetch(d))
        ranks = [r for r, *_ in rows]
        assert ranks == sorted(ranks) and ranks[0] == 1, f"{d}: odd rank order"
        out = os.path.join(tml_dir, f"{d[:4]}.csv")
        new_file = not os.path.exists(out)
        with open(out, "a", encoding="utf-8", newline="") as f:
            w = csv.writer(f, lineterminator="\r\n")  # as TML's files
            if new_file:
                w.writerow(["date", "rank", "name", "id", "points"])
            for rk, pid, slug, pts in rows:
                w.writerow([d.replace("-", ""), rk, html.unescape(name_of(pid, slug)), pid, "" if pts is None else pts])
        print(f"  {d}: {len(rows)} players, No. 1 {name_of(rows[0][1], rows[0][2])}", flush=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    chk = args[args.index("--check") + 1] if "--check" in args else None
    main(args[0], chk)
