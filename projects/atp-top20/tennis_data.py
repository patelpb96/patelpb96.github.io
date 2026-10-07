"""
Load, validate and clean ATP singles rankings.

Source: Tennismylife/TML-Rankings-Database (github), a scrape of the official
atptour.com lists with the 1973-84 era reconstructed week by week and the
1990-96 points filled in, plus player bios from Tennismylife/TML-Database.
(Jeff Sackmann's tennis_atp, the usual source, was taken down in 2026.)

    <rank_repo>/TML Rankings/YYYY.csv           completed weekly lists  (PRIMARY)
    <rank_repo>/Official ATP Rankings/YYYY.csv  lists as published by ATP (VERIFICATION)
    <db_repo>/ATP_Database.csv                  player bios

Every check appends an Issue: what was found, how many, examples, and the
corrective action taken ("flag only" where the data is ambiguous and should
not be silently changed).
"""
from __future__ import annotations

import glob
import io
import json
import os
import re
import unicodedata
from dataclasses import dataclass, field, asdict

import numpy as np
import pandas as pd

FIRST_OFFICIAL_YEAR = 1973  # official ATP rankings began 23 Aug 1973; nothing exists for 1970-72

KNOWN_GAPS = [(pd.Timestamp("2020-03-16"), pd.Timestamp("2020-08-24"),
               "COVID-19 tour suspension, rankings frozen")]

# Independent references used for verification (official ATP figures).
YEAR_END_NO1 = {
    1973: "Nastase", 1974: "Connors", 1975: "Connors", 1976: "Connors", 1977: "Connors",
    1978: "Connors", 1979: "Borg", 1980: "Borg", 1981: "McEnroe", 1982: "McEnroe",
    1983: "McEnroe", 1984: "McEnroe", 1985: "Lendl", 1986: "Lendl", 1987: "Lendl",
    1988: "Wilander", 1989: "Lendl", 1990: "Edberg", 1991: "Edberg", 1992: "Courier",
    1993: "Sampras", 1994: "Sampras", 1995: "Sampras", 1996: "Sampras", 1997: "Sampras",
    1998: "Sampras", 1999: "Agassi", 2000: "Kuerten", 2001: "Hewitt", 2002: "Hewitt",
    2003: "Roddick", 2004: "Federer", 2005: "Federer", 2006: "Federer", 2007: "Federer",
    2008: "Nadal", 2009: "Federer", 2010: "Nadal", 2011: "Djokovic", 2012: "Djokovic",
    2013: "Nadal", 2014: "Djokovic", 2015: "Djokovic", 2016: "Murray", 2017: "Nadal",
    2018: "Djokovic", 2019: "Nadal", 2020: "Djokovic", 2021: "Djokovic", 2022: "Alcaraz",
    2023: "Djokovic", 2024: "Sinner", 2025: "Alcaraz",
}
# Career weeks at No. 1 for players whose reign is over (official ATP totals).
WEEKS_AT_NO1 = {
    "Novak Djokovic": 428, "Roger Federer": 310, "Pete Sampras": 286, "Ivan Lendl": 270,
    "Jimmy Connors": 268, "Rafael Nadal": 209, "John McEnroe": 170, "Bjorn Borg": 109,
    "Andre Agassi": 101, "Lleyton Hewitt": 80, "Stefan Edberg": 72, "Jim Courier": 58,
    "Gustavo Kuerten": 43, "Andy Murray": 41, "Ilie Nastase": 40, "Mats Wilander": 20,
    "Daniil Medvedev": 16, "Andy Roddick": 13, "Boris Becker": 12, "Marat Safin": 9,
    "Juan Carlos Ferrero": 8, "Yevgeny Kafelnikov": 6, "Thomas Muster": 6, "Marcelo Rios": 6,
    "Carlos Moya": 2, "Patrick Rafter": 1,
}


@dataclass
class Issue:
    check: str
    severity: str          # error = data was wrong · warning = suspicious · info = expected quirk / reference
    count: int
    action: str
    examples: list = field(default_factory=list)


class IssueLog:
    def __init__(self):
        self.items: list[Issue] = []

    def add(self, check, severity, count, action, examples=None, always=False):
        if count or always:
            self.items.append(Issue(check, severity, int(count), action,
                                    json.loads(json.dumps(list(examples or [])[:10], default=str))))

    def to_json(self, path):
        with open(path, "w") as f:
            json.dump([asdict(i) for i in self.items], f, indent=2, ensure_ascii=False)

    def to_markdown(self, path, title="Data quality log"):
        sev = {"error": 0, "warning": 1, "info": 2}
        items = sorted(self.items, key=lambda i: sev[i.severity])
        out = [f"# {title}", "", "| Severity | Check | Count | Action |", "|---|---|---|---|"]
        out += [f"| {i.severity} | {i.check} | {i.count:,} | {i.action} |" for i in items]
        for i in items:
            if i.examples:
                out += ["", f"## {i.check}"] + [f"- {e}" for e in i.examples]
        with open(path, "w") as f:
            f.write("\n".join(out) + "\n")


# ---------------------------------------------------------------- reading

def read_csv_mixed(path: str, log: IssueLog | None = None) -> pd.DataFrame:
    """UTF-8 with a per-line cp1252 fallback (some rows were saved in Windows encoding)."""
    lines, fixed = [], []
    for i, raw in enumerate(open(path, "rb").read().split(b"\n")):
        try:
            lines.append(raw.decode("utf-8"))
        except UnicodeDecodeError:
            lines.append(raw.decode("cp1252", errors="replace"))
            fixed.append(f"{os.path.basename(path)} line {i + 1}: {lines[-1][:80]}")
    if log is not None:
        log.add("Lines not in UTF-8 (Windows-1252)", "error", len(fixed), "Re-decoded as cp1252", fixed)
    return pd.read_csv(io.StringIO("\n".join(lines)), dtype=str, keep_default_na=False, na_values=["", "NA", "NaN", "nan"])


def load_rankings(folder: str) -> pd.DataFrame:
    files = sorted(glob.glob(os.path.join(folder, "*.csv")))
    if not files:
        raise FileNotFoundError(folder)
    return pd.concat([read_csv_mixed(f).assign(source_file=os.path.basename(f)) for f in files],
                     ignore_index=True)


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    s = re.sub(r"\(.*?\)", "", s.lower())
    return re.sub(r"[^a-z]+", " ", s).strip()


# ---------------------------------------------------------------- players

def clean_players(path: str, log: IssueLog) -> pd.DataFrame:
    p = read_csv_mixed(path, log).rename(columns={"id": "player_id", "player": "name", "birthdate": "dob"})
    p["player_id"] = p["player_id"].str.strip()
    dup = p.duplicated("player_id")
    log.add("Duplicate player id in bios", "error", dup.sum(), "Kept first", p.loc[dup, "player_id"].tolist())
    p = p[~dup & p["player_id"].notna()].copy()
    p["name"] = p["name"].fillna(p["atpname"]).str.strip().str.replace(r"\s+", " ", regex=True)
    p["dob"] = pd.to_datetime(p["dob"], format="%Y%m%d", errors="coerce")
    p["height"] = pd.to_numeric(p["height"], errors="coerce")
    p["weight"] = pd.to_numeric(p["weight"], errors="coerce")
    p["turnedpro"] = pd.to_numeric(p["turnedpro"], errors="coerce")
    p["hand"] = p["hand"].fillna("").str.upper().where(lambda s: s.isin(["R", "L"]), None)
    return p.set_index("player_id")


def check_players(p: pd.DataFrame, used: set, log: IssueLog) -> pd.DataFrame:
    p = p.copy()
    u = p.index.isin(list(used))
    bad_dob = p["dob"].notna() & ((p["dob"].dt.year < 1900) | (p["dob"].dt.year > 2012))
    log.add("Implausible date of birth (ranked players)", "error", (bad_dob & u).sum(), "Set to missing",
            p.loc[bad_dob & u, ["name", "dob"]].reset_index().values.tolist())
    p.loc[bad_dob, "dob"] = pd.NaT
    bad_h = p["height"].notna() & ((p["height"] < 150) | (p["height"] > 215))
    log.add("Implausible height in cm (ranked players)", "error", (bad_h & u).sum(), "Set to missing",
            p.loc[bad_h & u, ["name", "height"]].reset_index().values.tolist())
    p.loc[bad_h, "height"] = np.nan
    bad_w = p["weight"].notna() & ((p["weight"] < 50) | (p["weight"] > 130))
    log.add("Implausible weight in kg (ranked players)", "error", (bad_w & u).sum(), "Set to missing",
            p.loc[bad_w & u, ["name", "weight"]].reset_index().values.tolist())
    p.loc[bad_w, "weight"] = np.nan
    ranked = p[u]
    log.add("Ranked players with no date of birth", "warning", ranked["dob"].isna().sum(), "Left blank",
            ranked.loc[ranked["dob"].isna(), "name"].tolist())
    clash = ranked[ranked["name"].duplicated(keep=False)].sort_values("name")
    log.add("Different players sharing one name", "info", clash["name"].nunique(),
            "Kept separate (ids differ); display name gets country/birth year",
            clash[["name", "ioc"]].reset_index().values.tolist())
    for nm, grp in clash.groupby("name"):
        for pid, row in grp.iterrows():
            tag = row["ioc"] if isinstance(row["ioc"], str) else (row["dob"].year if pd.notna(row["dob"]) else pid)
            p.at[pid, "name"] = f"{nm} ({tag})"
    p["name_first"], p["name_last"] = zip(*p["name"].map(split_name))
    return p


PARTICLES = {"de", "del", "della", "da", "di", "van", "von", "der", "den", "la", "le", "dos", "das", "du", "ter", "mc"}


def split_name(full: str):
    full = re.sub(r"\s*\(.*?\)$", "", full)
    t = full.split()
    if len(t) == 1:
        return "", t[0]
    i = len(t) - 1
    while i > 1 and t[i - 1].lower() in PARTICLES:
        i -= 1
    return " ".join(t[:i]), " ".join(t[i:])


# ---------------------------------------------------------------- rankings

def clean_rankings(r: pd.DataFrame, players: pd.DataFrame, log: IssueLog, label: str) -> pd.DataFrame:
    n0 = len(r)
    r = r.copy()
    r["date"] = pd.to_datetime(r["date"], format="%Y%m%d", errors="coerce")
    r["rank"] = pd.to_numeric(r["rank"], errors="coerce")
    r["points"] = pd.to_numeric(r["points"], errors="coerce")
    r["id"] = r["id"].str.strip()

    hdr = r["name"].eq("name") & r["rank"].isna()
    log.add(f"[{label}] Header line repeated inside a file", "error", hdr.sum(), "Rows dropped",
            r.loc[hdr, "source_file"].tolist())
    r = r[~hdr]
    bad = r["date"].isna() | r["rank"].isna() | r["name"].isna()
    log.add(f"[{label}] Unparseable date / rank / name", "error", bad.sum(), "Rows dropped",
            r.loc[bad, ["source_file", "name"]].values.tolist())
    r = r[~bad].copy()
    r["rank"] = r["rank"].astype(int)

    # Rows without a player id: resolve through the bio file by name
    noid = r["id"].isna()
    if noid.any():
        idx = {}
        for pid, row in players.iterrows():
            for nm in {row["name"], row.get("atpname")}:
                if isinstance(nm, str):
                    idx.setdefault(norm_name(nm), set()).add(pid)
                    if "(" in nm:  # "Chris Lewis (NZL)" also keyed with its tag
                        idx.setdefault(nm.lower().strip(), set()).add(pid)
        resolved, ambiguous, unresolved = {}, {}, []
        for nm in r.loc[noid, "name"].unique():
            hits = idx.get(nm.lower().strip()) or idx.get(norm_name(nm)) or set()
            if len(hits) == 1:
                resolved[nm] = next(iter(hits))
            elif len(hits) > 1:
                # break ties by who was active then (has an id'd row in the same years)
                yrs = set(r.loc[noid & (r["name"] == nm), "date"].dt.year)
                act = [h for h in hits if (r.loc[r["id"] == h, "date"].dt.year.isin(yrs)).any()]
                if len(act) == 1:
                    resolved[nm] = act[0]
                else:
                    ambiguous[nm] = sorted(hits)
            else:
                unresolved.append(nm)
        r.loc[noid, "id"] = r.loc[noid, "name"].map(resolved)
        still = r["id"].isna()
        r.loc[still, "id"] = "X:" + r.loc[still, "name"].map(norm_name).str.replace(" ", "-")
        best = r[noid].groupby("name")["rank"].min()
        log.add(f"[{label}] Rows with no player id", "error", int(noid.sum()),
                f"{len(resolved)} names matched to a bio by name; the rest get an 'X:<name>' id",
                [f"{n} -> {resolved[n]} (best rank {best[n]})" for n in sorted(resolved, key=lambda n: best[n])])
        log.add(f"[{label}] Names with no matching bio", "warning", len(unresolved) + len(ambiguous),
                "Kept with 'X:<name>' id; no bio fields",
                [f"{n} (best rank {best[n]})" for n in sorted(unresolved, key=lambda n: best[n])] +
                [f"{n}: ambiguous {v}" for n, v in ambiguous.items()])

    exact = r.duplicated(["date", "rank", "id", "points"])
    log.add(f"[{label}] Exact duplicate rows", "error", exact.sum(), "Dropped",
            r.loc[exact, ["date", "rank", "name"]].astype(str).values.tolist())
    r = r[~exact]
    multi = r.duplicated(["date", "id"], keep=False)
    if multi.any():
        ex = r[multi].groupby(["date", "id", "name"])["rank"].apply(list).reset_index()
        log.add(f"[{label}] Player listed twice on one list", "error", len(ex), "Kept the better rank",
                ex.assign(date=ex["date"].dt.strftime("%Y-%m-%d")).values.tolist())
        r = r.sort_values("rank").drop_duplicates(["date", "id"])

    zero = r.groupby("date")["points"].transform(lambda s: (s.fillna(0) == 0).all())
    r.loc[zero, "points"] = np.nan
    stray = r["points"].eq(0)
    log.add(f"[{label}] Isolated 0-point entries on lists that otherwise have points", "warning", stray.sum(),
            "Set to missing (a ranked player cannot hold 0 points)",
            r.loc[stray, ["date", "rank", "name"]].astype(str).head(10).values.tolist())
    r.loc[stray, "points"] = np.nan
    log.add(f"[{label}] Lists with every points value 0", "info", r.loc[zero, "date"].nunique(),
            "Points set to missing (not published for those lists)")

    nm = r.groupby("id")["name"].nunique()
    vary = nm[nm > 1].index
    log.add(f"[{label}] Same player id spelled differently across lists", "info", len(vary),
            "Bio name used everywhere",
            [f"{i}: {sorted(r.loc[r['id'] == i, 'name'].unique())}" for i in vary])

    r = r.rename(columns={"id": "player"}).sort_values(["date", "rank"]).reset_index(drop=True)
    log.add(f"[{label}] Rows kept", "info", len(r), f"{n0:,} raw -> {len(r):,} clean", always=True)
    return r[["date", "rank", "player", "name", "points", "source_file"]]


def check_calendar(r: pd.DataFrame, log: IssueLog, label: str) -> pd.Series:
    dates = pd.Series(sorted(r["date"].unique()))
    nm = dates[dates.dt.dayofweek != 0]
    early_nm, late_nm = nm[nm.dt.year < 1985], nm[nm.dt.year >= 1985]
    log.add(f"[{label}] Lists not dated on a Monday, 1985 on", "warning", len(late_nm), "Flag only",
            late_nm.dt.strftime("%Y-%m-%d %a").tolist())
    log.add(f"[{label}] Lists not dated on a Monday, before 1985", "info", len(early_nm),
            "Expected: early lists were issued on varying weekdays", early_nm.dt.strftime("%Y-%m-%d %a").tolist())
    gaps = dates.diff().dt.days
    unknown, known = [], []
    for i in np.where(gaps > 8)[0]:
        a, b = dates[i - 1], dates[i]
        if b.month == 1 and a.month in (11, 12):
            continue  # off-season: no lists between the year-end list and January
        why = next((w for s, e, w in KNOWN_GAPS if a <= s + pd.Timedelta(days=7) and b >= e - pd.Timedelta(days=7)), None)
        if a.year < 1985 and not why:
            continue  # irregular publication was normal before 1985; see the per-year count
        (known if why else unknown).append(f"{a:%Y-%m-%d} -> {b:%Y-%m-%d} ({int(gaps[i])} days){': ' + why if why else ''}")
    log.add(f"[{label}] In-season gaps longer than a week", "warning", len(unknown),
            "Flag only; plot lines bridge the gap", unknown)
    log.add(f"[{label}] Known gaps", "info", len(known), "Expected", known)
    py = dates.groupby(dates.dt.year).size()
    log.add(f"[{label}] Lists per year before 1985 (irregular era)", "info", int((py.index < 1985).sum()),
            "Reference: each list stays in force until the next one",
            [f"{y}: {n}" for y, n in py.items() if y < 1985])
    return dates


def check_lists(r: pd.DataFrame, log: IssueLog, label: str, top: int = 20) -> pd.DataFrame:
    t = r[r["rank"] <= top]
    per = pd.DataFrame({"n_top": t.groupby("date").size(), "depth": r.groupby("date")["rank"].max()}).fillna(0)
    per["complete_top"] = per["n_top"] >= top
    inc = per[~per["complete_top"]]
    log.add(f"[{label}] Lists with fewer than {top} players ranked 1-{top}", "error", len(inc),
            "Not used for year-end lists; kept for plotting",
            [f"{d:%Y-%m-%d}: {int(n)}" for d, n in inc["n_top"].items()])
    # rank sequence: with ties, rank k must equal 1 + number of players ranked above k
    seq = []
    for d, g in t.groupby("date"):
        ranks = g["rank"].sort_values().values
        expect = np.searchsorted(ranks, ranks, side="left") + 1
        if (ranks != expect).any():
            seq.append(f"{d:%Y-%m-%d}: {ranks.tolist()}")
    log.add(f"[{label}] Top-{top} rank numbers skip or repeat inconsistently", "error", len(seq),
            "Flag only (list kept)", seq)
    ties = t[t.duplicated(["date", "rank"], keep=False)]
    log.add(f"[{label}] Tied ranks inside the top {top}", "info", ties.groupby(["date", "rank"]).ngroups,
            "Kept; ties ordered by points then name",
            ties.groupby(["date", "rank"])["name"].apply(list).reset_index().assign(
                date=lambda x: x["date"].dt.strftime("%Y-%m-%d")).values.tolist())
    tp = r[(r["rank"] <= 100) & r["points"].notna()].sort_values(["date", "rank"])
    tp = tp.assign(above=tp.groupby("date")["points"].shift())
    inv = tp[tp["points"] > tp["above"]]
    log.add(f"[{label}] Top-100 player with more points than the player ranked above", "warning", len(inv),
            "Flag only (rank order is official)",
            inv.assign(date=inv["date"].dt.strftime("%Y-%m-%d"))[["date", "rank", "name", "points", "above"]].values.tolist())
    return per


def mark_spikes(r: pd.DataFrame, dates: pd.Series, log: IssueLog, label: str) -> pd.DataFrame:
    """Top-50 player listed far down for exactly one week, then back: a keying error."""
    di = {d: i for i, d in enumerate(dates)}
    r = r.assign(di=r["date"].map(di)).sort_values(["player", "di"])
    g = r.groupby("player")
    pr, nr, pd_, nd = g["rank"].shift(1), g["rank"].shift(-1), g["di"].shift(1), g["di"].shift(-1)
    nb = np.maximum(pr, nr)
    spike = ((r["di"] - pd_ == 1) & (nd - r["di"] == 1) & (nb <= 50) & (r["rank"] > np.maximum(200, 5 * nb))).fillna(False)
    r["suspect"] = spike
    log.add(f"[{label}] One-week rank spikes", "error", int(spike.sum()), "Skipped in plots and stats",
            [f"{d:%Y-%m-%d} {n}: {int(a)} -> {k} -> {int(b)}" for d, n, k, a, b in
             zip(r.loc[spike, "date"], r.loc[spike, "name"], r.loc[spike, "rank"], pr[spike], nr[spike])])
    # Dropped rows: in the top N the list before and after, missing from a deep list in between
    depth = r.groupby("date")["rank"].max()
    allrows = set(zip(r["player"], r["di"]))
    t = r[(r["rank"] <= 20) & ~r["suspect"]]
    tset = set(zip(t["player"], t["di"]))
    holes = [f"{dates[i + 1]:%Y-%m-%d} {pl}" for pl, i in tset
             if (pl, i + 2) in tset and (pl, i + 1) not in allrows and depth.get(dates[i + 1], 0) >= 100]
    log.add(f"[{label}] Top-20 player missing from one list", "error", len(holes),
            "Plot bridges the hole; top-20 runs treated as unbroken", sorted(holes))
    return r.drop(columns="di").sort_values(["date", "rank"]).reset_index(drop=True)


# ---------------------------------------------------------------- cross-checks

def compare_with_official(tml: pd.DataFrame, off: pd.DataFrame, log: IssueLog, top: int = 20):
    """Match each official list to the TML list within 6 days and compare the top N."""
    td = pd.Series(sorted(tml["date"].unique()))
    rows, n = [], 0
    tml_top = {d: g.set_index("player")["rank"] for d, g in tml[tml["rank"] <= top].groupby("date")}
    for d, g in off[off["rank"] <= top].groupby("date"):
        j = td.searchsorted(d)
        cands = [td[k] for k in (j - 1, j) if 0 <= k < len(td) and abs((td[k] - d).days) <= 6]
        if not cands:
            rows.append((d, None, "no TML list within 6 days"))
            continue
        m = min(cands, key=lambda x: abs((x - d).days))
        a, b = g.set_index("player")["rank"], tml_top.get(m, pd.Series(dtype=int))
        n += 1
        diff = [f"{p}: official {a.get(p)} vs TML {b.get(p)}" for p in sorted(set(a.index) | set(b.index))
                if a.get(p) != b.get(p)]
        if diff:
            rows.append((d, m, "; ".join(diff[:4]) + (" …" if len(diff) > 4 else "")))
    mism = [r for r in rows if r[1] is not None]
    log.add("TML weekly set vs official ATP lists: top-20 disagreements", "error" if mism else "info",
            len(mism), f"Flag only; {n - len(mism)}/{n} official lists match the TML list exactly",
            [f"{d:%Y-%m-%d} vs {m:%Y-%m-%d}: {t}" for d, m, t in mism], always=True)
    nolist = [r for r in rows if r[1] is None]
    log.add("Official lists with no TML list within 6 days", "warning", len(nolist), "Flag only",
            [f"{d:%Y-%m-%d}" for d, _, _ in nolist])


def year_end_top(r, per, players, log, top=20, today=None):
    today = today or pd.Timestamp.today()
    good = r[~r["suspect"]]
    complete = per.index[per["complete_top"]]
    out, notes = [], []
    for y in sorted(good["date"].dt.year.unique()):
        if y < FIRST_OFFICIAL_YEAR:
            continue
        ds = [d for d in complete if d.year == y]
        if not ds:
            notes.append(f"{y}: no complete list")
            continue
        d = max(ds)
        final = y < today.year
        if not final:
            notes.append(f"{y}: season in progress; latest list {d:%Y-%m-%d} is provisional")
        elif d.month < 11:
            notes.append(f"{y}: last list is {d:%Y-%m-%d}, before November")
        lst = good[(good["date"] == d) & (good["rank"] <= top)].sort_values(["rank", "points", "name"],
                                                                         ascending=[True, False, True])
        out.append(lst.assign(year=y, list_date=d, final=final))
    log.add("Year-end list notes", "info", len(notes), "Reference", notes)
    ye = pd.concat(out, ignore_index=True)
    ye["name"] = ye["player"].map(players["name"]).fillna(ye["name"])
    ye = ye.rename(columns={"player": "player_id"})[["year", "rank", "player_id", "name", "points", "list_date", "final"]]

    bad = []
    for y, sur in YEAR_END_NO1.items():
        no1 = ye[(ye["year"] == y) & (ye["rank"] == 1)]["name"].tolist()
        if not any(sur.lower() in norm_name(n) for n in no1):
            bad.append(f"{y}: data {no1 or 'missing'}, official {sur}")
    log.add("Year-end No. 1 vs official record", "error" if bad else "info", len(bad),
            f"{len(YEAR_END_NO1) - len(bad)}/{len(YEAR_END_NO1)} seasons match", bad, always=True)
    return ye


def check_weeks_at_no1(weeks: dict, log: IssueLog, label: str):
    rows, ok = [], 0
    for nm, ref in WEEKS_AT_NO1.items():
        got = weeks.get(nm)
        if got is None:
            rows.append(f"{nm}: not found")
        elif abs(got - ref) > 1.5:
            rows.append(f"{nm}: data {got:g} vs official {ref} ({got - ref:+g})")
        else:
            ok += 1
    log.add(f"[{label}] Career weeks at No. 1 vs official totals (±1.5 wk)", "error" if rows else "info",
            len(rows), f"{ok}/{len(WEEKS_AT_NO1)} players match", rows, always=True)


def list_durations(dates: pd.Series) -> pd.Series:
    """Days each list stays in force (until the next list). During the 2020 freeze the ATP stopped
    counting weeks, so the last pre-freeze list counts one week and any list inside the freeze counts 0."""
    d = pd.Series(sorted(dates)).reset_index(drop=True)
    dur = (d.shift(-1) - d).dt.days.fillna(7).astype(float)
    for s, e, _ in KNOWN_GAPS:
        inside = (d > s) & (d < e)
        dur[inside] = 0
        last_before = d[d <= s]
        if len(last_before):
            dur[last_before.index[-1]] = min(7, dur[last_before.index[-1]])
    return pd.Series(dur.values, index=d.values)


def build_canonical(tml: pd.DataFrame, off: pd.DataFrame, log: IssueLog, cutover: int = 1985) -> pd.DataFrame:
    """One ranking history to rule them all.
    - Before `cutover`: the lists the ATP actually published. The weekly lists in the TML set for these
      years are a fan reconstruction and disagree with the official lists (see the comparison check).
    - From `cutover` on: the TML weekly lists (identical to the official lists wherever both exist, and they
      carry the 1990-96 points ATP never published), plus any official list with no TML list within 6 days.
    Each row keeps `origin`: official | weekly."""
    early = off[off["date"].dt.year < cutover].assign(origin="official")
    late = tml[tml["date"].dt.year >= cutover].assign(origin="weekly")
    td_ = pd.Series(sorted(late["date"].unique()))
    od = pd.Series(sorted(off.loc[off["date"].dt.year >= cutover, "date"].unique()))
    pos = td_.searchsorted(od)
    lonely = [d for d, j in zip(od, pos)
              if not any(0 <= k < len(td_) and abs((td_[k] - d).days) <= 6 for k in (j - 1, j))]
    extra = off[off["date"].isin(lonely)].assign(origin="official")
    log.add("Canonical history: source by era", "info", 3,
            f"Official ATP lists before {cutover}; TML weekly lists from {cutover}", [
                f"{early['date'].nunique()} official lists {early['date'].min():%Y-%m-%d} -> {early['date'].max():%Y-%m-%d}",
                f"{late['date'].nunique()} weekly lists {late['date'].min():%Y-%m-%d} -> {late['date'].max():%Y-%m-%d}",
                f"{len(lonely)} official lists added where the weekly set has no list"], always=True)
    out = pd.concat([early, late, extra], ignore_index=True).sort_values(["date", "rank"]).reset_index(drop=True)
    return out
