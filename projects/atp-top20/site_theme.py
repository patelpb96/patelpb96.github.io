"""Re-skin the assembled explorer for patelpb96.github.io and add the site's back link.

    python site_theme.py out/atp_top20_explorer.html ../../public/projects/atp/index.html

The explorer itself is theme-agnostic (light/dark tokens on :root). This forces the dark theme and maps
its tokens onto the website's warm palette and serif headings, so the page reads as part of the site.
"""
import sys

THEME = """
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&display=swap">
<style>
/* patelpb96.github.io palette (see src/App.jsx :root) */
:root[data-theme="dark"] {
  --bg: #1a0f0a; --panel: #22120a; --ink: #fff2e6; --ink-2: #e6c7a8; --ink-3: #b08b6b;
  --line: #4a2c1a; --grid: #2c1a10; --accent: #ffb36b; --accent-ink: #1a0f0a; --accent-soft: #3a2214;
  --idle: rgba(255, 226, 200, .2); --idle-hi: #fff2e6; --brush: rgba(255, 154, 77, .16);
  --warn: #ffb36b; --err: #ff8a7a;
  --s1: #5aa9ff; --s2: #ff7a45; --s3: #3cc497; --s4: #ffc247; --s5: #ff7fb0; --s6: #9fd36a; --s7: #a99bff; --s8: #ff6b6b;
  --display: "Playfair Display", Georgia, "Times New Roman", serif;
  --body: "Playfair Display", Georgia, "Times New Roman", serif; /* serif throughout, like the site */
  color-scheme: dark;
}
button, input, select, textarea { font-family: var(--body); }
body { background: radial-gradient(120% 60% at 50% 0%, #2a160c 0%, #1a0f0a 55%, #120a06 100%) fixed; }
h1 span { color: var(--accent); }
.panel { box-shadow: 0 22px 70px rgba(0, 0, 0, .45); }
.seg button[aria-pressed=true] { background: linear-gradient(180deg, #ffe2c2, #ff9a4d); color: #1a0f0a; }
.sitebar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
.sitebar a { color: var(--ink-2); text-decoration: none; border-bottom: 1px solid transparent; }
.sitebar a:hover { color: #ffd9b3; border-bottom-color: var(--line); }
.sitebar .who { font: 700 15px var(--display); color: var(--ink); letter-spacing: .01em; }
.sitebar nav { display: flex; gap: 16px; }
</style>
"""
BAR = """<nav class="sitebar" aria-label="Site">
    <a href="/#/projects">← All projects</a>
    <span class="who">Preet Patel</span>
    <nav><a href="https://github.com/patelpb96/patelpb96.github.io/tree/main/public/projects/atp/data" target="_blank" rel="noreferrer">Data (CSV)</a><a href="https://github.com/patelpb96/patelpb96.github.io/tree/main/projects/atp-top20" target="_blank" rel="noreferrer">Source</a></nav>
  </nav>
"""

src, dst = sys.argv[1], sys.argv[2]
html = open(src, encoding="utf-8").read()
assert '<html lang="en">' in html and '<div class="wrap">' in html and "</style>" in html
html = html.replace('<html lang="en">', '<html lang="en" data-theme="dark">', 1)
i = html.index("</style>") + len("</style>")  # after the explorer's own styles, so these win
html = html[:i] + THEME + html[i:]
html = html.replace('<div class="wrap">', '<div class="wrap">\n  ' + BAR, 1)
html = html.replace("<title>ATP Top 20 Explorer</title>", "<title>ATP Top 20 Explorer · Preet Patel</title>", 1)
open(dst, "w", encoding="utf-8", newline="").write(html)
print(f"{len(html) / 1e6:.2f} MB -> {dst}")
