"""Inject explorer_data.json into the page template:  python assemble.py out/explorer_data.json out/atp_top20_explorer.html
If top10_metrics.json (from top10_metrics.py) sits next to the data file, it is injected too and enables the "Top 10" group."""
import os
import sys
data = open(sys.argv[1], encoding="utf-8").read().replace("</", "<\\/")
html = open("explorer_template.html", encoding="utf-8").read().replace("/*__DATA__*/null", data, 1)
top10 = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "top10_metrics.json")
if os.path.exists(top10):
    html = html.replace("/*__TOP10__*/null", open(top10, encoding="utf-8").read().replace("</", "<\\/"), 1)
    print(f"included {top10}")
open(sys.argv[2], "w", encoding="utf-8").write(html)
print(f"{len(html)/1e6:.2f} MB -> {sys.argv[2]}")
