"""Download a photo of every player in profiles.json from atptour.com (Wikimedia Commons as a fallback).

    uv run --with playwright python fetch_player_photos.py [out_dir]   (default sources/photos)

atptour.com sits behind Cloudflare, so images are fetched from inside a real Chrome page (Playwright,
channel="chrome": the installed browser, no download). Per player it tries, in order:
  1. player-gladiator-headshot  (waist-up cut-out, transparent background; current-era players)
  2. player-headshot            (head and shoulders)
  3. Wikidata/Commons image    (matched on the ATP id, P536; for players ATP has no photo of)
Saves <out_dir>/<id>.<kind>.<ext> and manifest.json (with each photo's credit: author, licence, source). Re-running skips players already in the manifest.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.async_api import async_playwright

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
FETCH = """async u => { const r = await fetch(u); if (!r.ok) return [r.status, '', ''];
  const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return [r.status, r.headers.get('content-type') || '', btoa(s)]; }"""


WD_UA = {"User-Agent": "atp-top20-explorer/1.0 (patelpb96.github.io)"}


def wikidata_images() -> dict[str, str]:
    """ATP player id (Wikidata P536) -> Commons image (P18), for every player that has both. One query."""
    q = "SELECT ?atp ?img WHERE { ?p wdt:P536 ?atp ; wdt:P18 ?img . }"
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": q, "format": "json"})
    rows = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=WD_UA), timeout=120))["results"]["bindings"]
    return {r["atp"]["value"].upper(): r["img"]["value"] for r in rows}


def commons_image(file_url: str) -> bytes | None:
    for attempt in range(5):  # Wikimedia rate-limits bursts (HTTP 429)
        try:
            time.sleep(1.5)
            req = urllib.request.Request(file_url.replace("http://", "https://") + "?width=900", headers=WD_UA)
            return urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(10 * (attempt + 1))
    return None


def commons_credit(file_url: str) -> dict:
    """Author, licence and page of a Commons file (attribution for the portrait)."""
    title = "File:" + urllib.parse.unquote(file_url.split("Special:FilePath/", 1)[1])
    q = urllib.parse.urlencode({"action": "query", "format": "json", "titles": title, "prop": "imageinfo", "iiprop": "extmetadata|url"})
    for attempt in range(5):
        try:
            time.sleep(1)
            pages = json.load(urllib.request.urlopen(urllib.request.Request(f"https://commons.wikimedia.org/w/api.php?{q}", headers=WD_UA), timeout=60))["query"]["pages"]
            break
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(10 * (attempt + 1))
    info = next(iter(pages.values()))["imageinfo"][0]
    meta = info.get("extmetadata", {})
    text = lambda k: html.unescape(re.sub(r"<[^>]+>", "", meta.get(k, {}).get("value", ""))).strip()
    return {"author": re.sub(r"\s+", " ", text("Artist")) or "unknown", "license": text("LicenseShortName") or "see source",
            "source": info.get("descriptionurl") or f"https://commons.wikimedia.org/wiki/{urllib.parse.quote(title)}"}


ATP_CREDIT = {"author": "ATP Tour", "license": "© ATP Tour", "source": "https://www.atptour.com/en/players/-/{}/overview"}


def credit_for(kind: str, atp_id: str, wd: dict) -> dict:
    if kind == "wiki": return commons_credit(wd[atp_id.upper()])
    return {**ATP_CREDIT, "source": ATP_CREDIT["source"].format(atp_id.lower())}


async def main(out: str):
    os.makedirs(out, exist_ok=True)
    profiles = json.load(open("profiles.json", encoding="utf-8"))["profiles"]
    mpath = os.path.join(out, "manifest.json")
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {}
    wd = wikidata_images()
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True, args=["--disable-blink-features=AutomationControlled"])
        pg = await b.new_page(user_agent=UA)
        await pg.goto("https://www.atptour.com/en/players/roger-federer/f324/overview", wait_until="domcontentloaded", timeout=90000)
        await pg.wait_for_timeout(4000)
        # ATP's "no photo" silhouette: whatever an id that cannot exist returns
        blank = set()
        for kind in ("player-gladiator-headshot", "player-headshot"):
            st, _, data = await pg.evaluate(FETCH, f"/-/media/alias/{kind}/ZZ99")
            if st == 200: blank.add(hashlib.sha1(base64.b64decode(data)).hexdigest())
        for i, (pid, a) in enumerate(sorted(profiles.items())):
            if manifest.get(pid, {}).get("kind"):  # have it (misses are retried); backfill the credit if missing
                if "credit" not in manifest[pid]: manifest[pid]["credit"] = credit_for(manifest[pid]["kind"], a["atp_id"], wd)
                continue
            got = None
            for kind, short in (("player-gladiator-headshot", "gladiator"), ("player-headshot", "headshot")):
                st, ctype, data = await pg.evaluate(FETCH, f"/-/media/alias/{kind}/{a['atp_id'].lower()}")
                if st != 200 or not ctype.startswith("image/"): continue
                raw = base64.b64decode(data)
                if hashlib.sha1(raw).hexdigest() in blank or len(raw) < 3000: continue
                got = (short, ctype.split("/")[1].split(";")[0].replace("jpeg", "jpg"), raw); break
            if not got and a["atp_id"].upper() in wd:
                try:
                    raw = commons_image(wd[a["atp_id"].upper()])
                    if raw: got = ("wiki", "png" if raw[:4] == b"\x89PNG" else "jpg", raw)
                except Exception as e:  # noqa: BLE001
                    print(f"  wiki failed for {a['name']}: {e}")
            if got:
                fn = f"{pid}.{got[0]}.{got[1]}"
                open(os.path.join(out, fn), "wb").write(got[2])
                manifest[pid] = {"name": a["name"], "kind": got[0], "file": fn, "credit": credit_for(got[0], a["atp_id"], wd)}
            else:
                manifest[pid] = {"name": a["name"], "kind": None, "file": None}
            print(f"{i + 1:3}/{len(profiles)} {a['name']}: {manifest[pid]['kind']}", flush=True)
            if i % 20 == 0: json.dump(manifest, open(mpath, "w"), indent=1)
        await b.close()
    json.dump(manifest, open(mpath, "w"), indent=1)
    kinds = [m["kind"] for m in manifest.values()]
    print({k: kinds.count(k) for k in set(kinds)})


asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else os.path.join("sources", "photos")))
