import AlchemyDashboard from "./Alchemy.jsx";
import "./alchemy-page.css";

// Standalone page at /projects/alchemy/ (second Vite entry, see vite.config.js), laid out like the
// tennis explorer at /projects/atp/: a site bar back to the portfolio, a title, then the full-width tool.
export default function AlchemyPage() {
  return (
    <div className="wrap">
      <nav className="sitebar" aria-label="Site">
        <a href="/#/projects">← All projects</a>
        <span className="who">Preet Patel</span>
        <nav>
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
