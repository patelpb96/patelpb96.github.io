"""top10_metrics.json -> CSV (one row per list: each metric, plus that list's top 10 names).

    uv run --no-project --with polars python top10_csv.py top10_metrics.json top10_metrics.csv
"""
import json
import sys
from datetime import date

import polars as pl

t = json.load(open(sys.argv[1], encoding="utf-8"))
cols = {"date": [date(d // 10000, d // 100 % 100, d % 100) for d in t["dates"]]}
cols.update({k: v["values"] for k, v in t["metrics"].items()})
cols["top10"] = ["; ".join(t["names"][i] for i in m) for m in t["members"]]
df = pl.DataFrame(cols)
df.write_csv(sys.argv[2])
print(df.shape, df.columns)
