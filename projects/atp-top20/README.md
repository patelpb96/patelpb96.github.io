# ATP Top 20 data pipeline

## Source
Jeff Sackmann's `tennis_atp` repo was taken down in 2026. Replacement:
- `Tennismylife/TML-Rankings-Database` — official atptour.com lists (1973 → Jul 2025) and a completed weekly set (1973 → 19 Jan 2026)
- atptour.com directly for lists after 19 Jan 2026, when the TML repo stopped updating (`fetch_atp_lists.py`, below)
- `Tennismylife/TML-Database` — `ATP_Database.csv` player bios keyed by ATP id

Canonical history = official ATP lists before 1985 + TML weekly lists from 1985.
Why: from 1985 on the weekly set matches every official list exactly; for 1973–84 the weekly set is a fan
reconstruction that disagrees with all 355 official lists of that era (it makes Vilas the 1975 No. 1).
The reconstruction is kept separately in `rankings_reconstructed_1973_1984.csv`.

Verification: 53/53 year-end No. 1s and 26/26 career weeks-at-No.-1 totals match the official record.

## Run
    git clone --depth 1 https://github.com/Tennismylife/TML-Rankings-Database
    git clone --depth 1 https://github.com/Tennismylife/TML-Database
    # TML stopped at 19 Jan 2026: append every newer list ATP has published (re-run any time; skips dates it has)
    python fetch_atp_lists.py TML-Rankings-Database
    python -X utf8 build.py TML-Rankings-Database TML-Database out
    uv run --with polars python top10_metrics.py TML-Rankings-Database TML-Database out/explorer_data.json out/top10_metrics.json
    python assemble.py out/explorer_data.json out/atp_top20_explorer.html
    uv run --no-project --with polars python top10_csv.py out/top10_metrics.json out/top10_metrics.csv

`top10_metrics.py` (polars) derives the "Top 10" group: whoever is ranked 1-10 on each list, plotted as
a property of those players (avg rank a year earlier/later, new vs a year earlier, changes per list, average
and youngest age, weeks already in the top 10, countries). It reads the full ranking history, not only the
Top20s players. `assemble.py` injects `top10_metrics.json` when it sits next to the data file.

## Profiles (profiles.py)
    from profiles import ProfileStore
    store = ProfileStore.load("out/profiles.json")
    store.get("F324")                       # Roger Federer
    store.find("alcaraz")
    store.add("nickname", {"D643": "Nole"})  # static attribute
    store.add("age_first_top20", lambda pid, c: ...)  # computed attribute (pass ctx to recompute)
    store.remove("coaches")
    store.save("out/profiles.json")
The explorer's profile card renders whatever attributes exist, so added ones appear after a rebuild.

## Outputs
- `top20s_year_end.csv` — Top20s: year-end top 20, 1973–2025 (2026 provisional rows flagged `final=False`)
- `top20s_players.csv` (254) / `top20s_21st_century.csv` (129) — sorted by first name
- `rankings_top20s_players.csv` — every list entry, any rank, for every Top20s player
- `rankings_clean.csv` — full canonical history (regenerate; ~225 MB)
- `data_quality.md` — every check, count, examples, corrective action

## On the website
Live at https://patelpb96.github.io/projects/atp/ (linked from the Projects page). To republish after a rebuild:

    python assemble.py out/explorer_data.json out/atp_top20_explorer.html
    python site_theme.py out/atp_top20_explorer.html ../../public/projects/atp/index.html

`site_theme.py` maps the explorer's colour tokens onto the site's palette and adds the back link.
The CSVs served alongside it are in `public/projects/atp/data/` (`top10_metrics.csv` is the Top 10 group's
derived metrics per list, with that list's top 10 names).

## Data credit
Rankings and player bios: Tennismylife's [TML-Rankings-Database](https://github.com/Tennismylife/TML-Rankings-Database)
and [TML-Database](https://github.com/Tennismylife/TML-Database). Neither repo states a licence; the derived CSVs
here are shared for non-commercial reference with that credit.
