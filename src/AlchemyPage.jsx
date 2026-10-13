import { useEffect, useState } from "react";
import AlchemyDashboard from "./Alchemy.jsx";
import "./alchemy-page.css";

// Text-size presets, same steps as the tennis explorer. They scale the root font size (--fs in
// alchemy-page.css), and the dashboard is sized in rem, so the whole table follows.
const TEXT_SIZES = [
  { fs: 0.9, label: "Small text", px: 11 },
  { fs: 1, label: "Medium text", px: 13 },
  { fs: 1.12, label: "Large text", px: 15 },
  { fs: 1.25, label: "Extra large text", px: 17 },
];
const TEXT_SIZE_KEY = "alc-textsize";

function savedTextSize() {
  try {
    const v = Number(localStorage.getItem(TEXT_SIZE_KEY));
    return TEXT_SIZES.some((s) => s.fs === v) ? v : 1;
  } catch {
    return 1;
  }
}

// Standalone page at /projects/alchemy/ (second Vite entry, see vite.config.js), laid out like the
// tennis explorer at /projects/atp/: a site bar back to the portfolio, a title, then the full-width tool.
export default function AlchemyPage() {
  const [fs, setFs] = useState(savedTextSize);

  useEffect(() => {
    document.documentElement.style.setProperty("--fs", String(fs));
    try { localStorage.setItem(TEXT_SIZE_KEY, String(fs)); } catch { /* not remembered */ }
  }, [fs]);

  return (
    <div className="wrap">
      <nav className="sitebar" aria-label="Site">
        <a href="/#/projects">← All projects</a>
        <span className="who">Preet Patel</span>
        <nav>
          <div className="textsize" role="group" aria-label="Text size" title="Text size">
            {TEXT_SIZES.map((s) => (
              <button key={s.fs} type="button" aria-label={s.label} aria-pressed={fs === s.fs} style={{ fontSize: s.px }} onClick={() => setFs(s.fs)}>A</button>
            ))}
          </div>
          <a href="https://github.com/patelpb96/patelpb96.github.io/tree/main/public/rs-alchemy/data" target="_blank" rel="noreferrer">Data</a>
          <a href="https://github.com/patelpb96/patelpb96.github.io/blob/main/src/Alchemy.jsx" target="_blank" rel="noreferrer">Source</a>
        </nav>
      </nav>

      <header className="page-head">
        <h1>RuneScape <span>High Alchemy</span></h1>
        <p className="sub">Which Grand Exchange items are worth buying to alch, right now and historically.</p>
      </header>

      <AlchemyDashboard />
    </div>
  );
}
