"""Open a hit's page as plain text. Direct HTTP first (no Exa call); the dry run uses FixturePages instead.

A page is untrusted data. Only https URLs to named hosts are fetched (no IP literals, no localhost), the
body is capped, and tags are stripped. It still goes through the injection screen before anything reads it.
DNS-level SSRF protection is not attempted here; the Lambda should add its own egress controls.
"""
from __future__ import annotations

import html
import ipaddress
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit

MAX_BYTES = 1_000_000


class FetchRefused(Exception):
    pass


def check_url(url: str) -> None:
    p = urlsplit(url)
    host = (p.hostname or "").lower()
    if p.scheme != "https" or not host or host == "localhost" or host.endswith((".local", ".internal")):
        raise FetchRefused(f"only https URLs to public named hosts are fetched: {host or url[:40]!r}")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return
    raise FetchRefused("IP-literal hosts are not fetched")


def strip_html(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|noscript|template)\b.*?</\1>", " ", raw)
    raw = re.sub(r"(?s)<!--.*?-->", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"(?s)<[^>]+>", " ", raw))).strip()


class LivePages:
    def get(self, url: str) -> str | None:
        check_url(url)
        req = urllib.request.Request(url, headers={"User-Agent": "patelpb-model-tracker/1", "Accept": "text/html,text/plain"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return strip_html(r.read(MAX_BYTES).decode(r.headers.get_content_charset() or "utf-8", "replace"))
        except (urllib.error.URLError, TimeoutError, ValueError):
            return None


class FixturePages:
    def __init__(self, pages: dict[str, str]):
        self.pages = pages

    def get(self, url: str) -> str | None:
        return self.pages.get(url)
