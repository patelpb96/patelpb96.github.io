import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import AlchemyDashboard from "./Alchemy.jsx";

const base = "https://patelpb96.github.io";

const assets = {
  bg: `${base}/bg.jpg`,
  bgGif: `${base}/assets/bg.gif`,
  introImg: `${base}/images/pic01.webp`, // WebP re-encodes; originals (pic01.png, pfp.jpg) kept in public/
  pfp: `${base}/pfp.webp`, // 1200px wide, ~230 kB (was a 1.6 MB 1365x2048 JPEG)
  galaxies: `${base}/images/8gals_GIF.gif`,
  graphics: [
    `${base}/images/A1.webp`,
    `${base}/images/A85.webp`,
    `${base}/images/Joey.gif`,
    `${base}/images/Kylo.gif`,
    `${base}/images/Pkh.gif`,
  ],
};

// Home lives on one scrolling page; #/projects is a portal of cards, each project has its own page.
const sections = ["Intro", "Research", "Resume", "Contact"];
const projects = [
  {
    key: "atp",
    title: "ATP Top 20 Explorer",
    href: "/projects/atp/",
    external: true,
    blurb: "Every player who held a top-20 ATP ranking since 1973, on one chart. Pick a time window, compare rivals, build groups like the Big Three, and overlay moving averages with momentum.",
    tags: ["Tennis", "Data viz", "Python · polars"],
    art: "lines",
  },
  {
    key: "alchemy",
    title: "Alchemy",
    href: "#/projects/alchemy",
    blurb: "A live RuneScape Grand Exchange dashboard: high-alchemy profit for 7,000+ items, with price history back to 2008.",
    tags: ["Dashboard", "Live data"],
    art: "coins",
  },
  {
    key: "graphics",
    title: "Graphics",
    href: "#/projects/graphics",
    blurb: "Transparent animated forum signatures and older space art, made web-safe with WebP.",
    tags: ["Animation", "Design"],
    art: "spark",
  },
];

// GizmoElementTracers results/apogee_dtd_conserved: every Ia delay-time-distribution family fit to the same
// APOGEE DR17 target at the same fixed Ia event count, ranked by chi^2 (9 summary statistics, posterior median).
// Only the three best of the ten families are shown.
const DTD_FAMILIES = 10;
const dtdRuns = [
  { key: "mannucci_prompt", name: "Mannucci prompt + tardy (free shape)", chi2: 18.5, mb: 2.2, blurb: "A prompt Gaussian burst plus a constant tardy rate, with the burst's share, time and width fitted. The best fit of the ten: about 81% of the explosions land in a prompt peak near 43 Myr." },
  { key: "peak_growth", name: "Skewed peak + exponential growth", chi2: 24.4, mb: 3.0, blurb: "A new model: a skewed Gaussian peak followed by a slowly, exponentially growing tail. The peak holds about two thirds of the explosions." },
  { key: "skewnorm", name: "Skew-normal (Strolger et al. 2020)", chi2: 25.2, mb: 2.2, blurb: "A single skewed Gaussian delay-time distribution, with its location, width and skew fitted." },
];

const contactCards = [
  { label: "Email", value: "patelpb96@gmail.com", href: "mailto:patelpb96@gmail.com", icon: "mail" },
  // The phone line (already a factorization of the number) is XOR-encoded here and shown jumbled
  // until a visitor presses "Unscramble", so it never sits in the page as readable text.
  { label: "Phone", encoded: [104, 232, 122, 141, 122, 107, 99, 99, 122, 141, 122, 109, 99, 104, 105, 111, 108, 105], href: null, icon: "phone" },
  { label: "GitHub", value: "patelpb96", href: "https://github.com/patelpb96", icon: "github" },
  { label: "LinkedIn", value: "patelpb96", href: "https://www.linkedin.com/in/patelpb96/", icon: "linkedin" },
];

const decodeText = (codes) => String.fromCharCode(...codes.map((c) => c ^ 0x5a));
const FIXED = /[\s@.×]/; // characters that stay put while the rest are jumbled
// a stable jumble of the text's own characters (spaces stay where they are), shown until it is unscrambled
function jumble(codes) {
  const chars = [...decodeText(codes)];
  const idx = chars.map((ch, i) => (FIXED.test(ch) ? -1 : i)).filter((i) => i >= 0);
  const moved = idx.map((i) => chars[i]);
  for (let i = moved.length - 1; i > 0; i--) { const j = Math.floor(seededRandom(i * 7.31 + 3) * (i + 1)); [moved[i], moved[j]] = [moved[j], moved[i]]; }
  idx.forEach((i, k) => { chars[i] = moved[k]; });
  return chars.join("");
}

function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function gaussianRandom(seed) {
  const u1 = Math.max(seededRandom(seed), 0.0001);
  const u2 = seededRandom(seed + 97.3);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function makeStarField(count, seed, options) {
  const { centerBias = 0.32, minSize = 0.7, maxSize = 1.8, alpha = 0.4, glow = false, fullOpacity = false } = options;

  return Array.from({ length: count }, (_, index) => {
    const i = index + 1;
    const useGaussian = seededRandom(seed + i * 11.7) < centerBias;
    const rawX = useGaussian ? 50 + gaussianRandom(seed + i * 2.1) * 18 : seededRandom(seed + i * 3.1) * 100;
    const rawY = useGaussian ? 50 + gaussianRandom(seed + i * 4.7) * 18 : seededRandom(seed + i * 5.3) * 100;
    const x = Math.min(99, Math.max(1, rawX));
    const y = Math.min(99, Math.max(1, rawY));
    const size = minSize + seededRandom(seed + i * 7.9) * (maxSize - minSize);
    const opacity = fullOpacity ? 1 : alpha * (0.45 + seededRandom(seed + i * 13.1) * 0.55);
    const blur = glow ? size * 1.35 : size * 0.35;
    const color = `rgba(255, 255, 255, ${opacity})`;
    const starLayer = `radial-gradient(circle at ${x}% ${y}%, ${color} 0 ${size}px, transparent ${size + 0.8}px)`;
    const glowLayer = glow
      ? `radial-gradient(circle at ${x}% ${y}%, rgba(255,255,255,${opacity * 0.55}) 0 ${size * 1.45}px, transparent ${blur + 1.35}px)`
      : null;

    return glowLayer ? `${starLayer}, ${glowLayer}` : starLayer;
  }).join(",\n          ");
}

// Background stars as small repeating tiles (the old wallpaper trick): each layer draws ~1/10 of the stars it
// used to and repeats them. Layers use different tile sizes so the repeats never line up into a visible pattern.
function makeStarTile(count, seed, tilePx, options) {
  const { minSize, maxSize, alpha } = options;
  const stars = Array.from({ length: count }, (_, index) => {
    const i = index + 1;
    const x = 2 + seededRandom(seed + i * 3.1) * 96; // keep clear of the tile edge so no star is cut in half
    const y = 2 + seededRandom(seed + i * 5.3) * 96;
    const size = minSize + seededRandom(seed + i * 7.9) * (maxSize - minSize);
    const opacity = alpha * (0.45 + seededRandom(seed + i * 13.1) * 0.55);
    return `radial-gradient(circle at ${x}% ${y}%, rgba(255, 255, 255, ${opacity}) 0 ${size}px, transparent ${size + 0.8}px)`;
  });
  return { image: stars.join(", "), size: Array(count).fill(`${tilePx}px ${tilePx}px`).join(", ") };
}
const joinTiles = (...tiles) => ({ image: tiles.map((t) => t.image).join(", "), size: tiles.map((t) => t.size).join(", ") });

// page background (fixed, full screen) and the hero card's back layers; tile sizes are deliberately unrelated
const starTiles = {
  page: joinTiles(
    makeStarTile(28, 908, 331, { minSize: 0.25, maxSize: 0.7, alpha: 0.30 }),
    makeStarTile(22, 3695, 359, { minSize: 0.3, maxSize: 0.8, alpha: 0.42 }),
    makeStarTile(18, 4397, 383, { minSize: 0.35, maxSize: 0.9, alpha: 0.52 }),
    makeStarTile(15, 5201, 409, { minSize: 0.4, maxSize: 1.0, alpha: 0.62 }),
  ),
  farBack: makeStarTile(28, 1907, 157, { minSize: 0.25, maxSize: 0.7, alpha: 0.30 }),
  midBack: makeStarTile(22, 2713, 167, { minSize: 0.3, maxSize: 0.8, alpha: 0.42 }),
  mid: makeStarTile(18, 6121, 179, { minSize: 0.35, maxSize: 0.9, alpha: 0.52 }),
  back: makeStarTile(15, 7019, 191, { minSize: 0.4, maxSize: 1.0, alpha: 0.62 }),
};

// Seeds re-rolled 2026-10-07. front/ultraFront were searched so every bright star (with its glow)
// clears the hero text at widths 540-1920px while staying on the card; the back layers sit behind the text.
const starFields = {
  front: makeStarField(14, 3211.293, { centerBias: 0.12, minSize: 1.1, maxSize: 2.2, alpha: 1.0, glow: true }),
  ultraFront: makeStarField(4, 4616.537, { centerBias: 0.08, minSize: 2.2, maxSize: 4.0, alpha: 1.0, glow: true, fullOpacity: true }),
};

// Nothing heavy downloads until the visitor asks for it.
function LazyGraphic({ src, alt, label = "Click to load image", size = "50+ MB", className }) {
  const [loaded, setLoaded] = useState(false);

  if (!loaded) {
    return (
      <button className={`lazy-graphic${className ? " lazy-wide" : ""}`} type="button" onClick={() => setLoaded(true)} aria-label={`Load ${alt}`}>
        <span>{label}</span>
        <small>{size}</small>
      </button>
    );
  }

  return <img src={src} alt={alt} loading="lazy" className={className} />;
}

// One fit per slide. Nothing downloads until a movie is asked for; after that, moving to another slide
// loads that slide's movie too (the visitor has opted in).
function DtdCarousel() {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const touch = useRef(null);
  const n = dtdRuns.length, run = dtdRuns[i];
  const go = (d) => setI((k) => (k + d + n) % n);
  const poster = `/images/dtd/${run.key}.webp`;
  return (
    <div className="dtd-carousel" role="region" aria-roledescription="carousel" aria-label="APOGEE fits, one per delay-time distribution" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1); }}
      onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => { if (touch.current == null) return; const dx = e.changedTouches[0].clientX - touch.current; touch.current = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }}>
      <div className="dtd-stage">
        {playing
          ? <video key={run.key} className="dtd-video" src={`/videos/dtd/${run.key}.mp4`} poster={poster} controls autoPlay muted loop playsInline title={`${run.name}: MCMC walkers converging on the APOGEE target`} />
          : (
            <button className="dtd-load" type="button" onClick={() => setPlaying(true)} aria-label={`Load the movie for ${run.name}`} style={{ backgroundImage: `url(${poster})` }}>
              <span>▶ Click to load movie</span>
              <small>MP4 · {run.mb} MB · 11 s</small>
            </button>
          )}
        <button className="dtd-arrow prev" type="button" onClick={() => go(-1)} aria-label="Previous fit">‹</button>
        <button className="dtd-arrow next" type="button" onClick={() => go(1)} aria-label="Next fit">›</button>
      </div>
      <div className="dtd-caption" aria-live="polite">
        <div className="dtd-title"><span className="dtd-rank">#{i + 1} of {DTD_FAMILIES}</span><b>{run.name}</b><span className="dtd-chi">χ² {run.chi2.toFixed(1)}</span></div>
        <p>{run.blurb}</p>
      </div>
      <div className="dtd-dots" role="tablist" aria-label="Choose a fit">
        {dtdRuns.map((r, k) => <button key={r.key} type="button" role="tab" aria-selected={k === i} aria-label={`#${k + 1} ${r.name}`} title={`#${k + 1} ${r.name}`} className={k === i ? "on" : ""} onClick={() => setI(k)} />)}
      </div>
    </div>
  );
}

function assertSiteData() {
  if (typeof console === "undefined" || typeof console.assert !== "function") return;
  console.assert(Array.isArray(sections), "sections should be an array");
  console.assert(sections.length === 4, "expected four home navigation sections");
  console.assert(projects.length === 3 && projects.every((p) => p.title && p.href), "projects portal should list three linked projects");
  console.assert(base.startsWith("https://"), "base URL should be absolute HTTPS");
  console.assert(assets.bg.endsWith("/bg.jpg"), "background image should use the hosted bg image");
  console.assert(assets.pfp === `${base}/pfp.webp`, "hero image should use pfp.webp");
  console.assert(assets.introImg === `${base}/images/pic01.webp`, "intro image should use images/pic01.webp");
  console.assert(assets.graphics.length >= 5, "graphics section should include newer and older animations");
  console.assert(contactCards.some((card) => card.href?.startsWith("mailto:")), "contact cards should include a mailto link");
  console.assert(contactCards.some((card) => card.encoded && decodeText(card.encoded).includes("199")), "the phone card should carry its (encoded) factorization");
  console.assert(contactCards.every((card) => card.label && card.icon), "each contact card should have a label and icon key");
  console.assert(!contactCards.some((card) => card.label === "Twitter"), "Twitter should not be included");
  console.assert(`${base}/assets/Resume_public.pdf`.endsWith("assets/Resume_public.pdf"), "resume link should point to the hosted PDF");
  for (const [name, t] of Object.entries(starTiles)) {
    console.assert(t.image.split("radial-gradient").length - 1 === t.size.split(",").length, `${name}: one tile size per star`);
  }
  console.assert(starFields.front.includes("radial-gradient"), "front star field should contain gradients");
  console.assert(starFields.ultraFront.includes("radial-gradient"), "ultra-front star field should contain gradients");
}

assertSiteData();

function Icon({ name, size = 20, className = "" }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className,
    "aria-hidden": true,
  };

  switch (name) {
    case "mail":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
    case "download":
      return <svg {...common}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>;
    case "external":
      return <svg {...common}><path d="M14 3h7v7" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></svg>;
    case "github":
      return <svg {...common}><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" /><path d="M9 18c-4.51 2-5-2-7-2" /></svg>;
    case "linkedin":
      return <svg {...common}><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" /><rect x="2" y="9" width="4" height="12" /><circle cx="4" cy="4" r="2" /></svg>;
    case "phone":
      return <svg {...common}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.9 19.9 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.9 19.9 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.35 1.89.66 2.79a2 2 0 0 1-.45 2.11L8.05 9.9a16 16 0 0 0 6.05 6.05l1.27-1.27a2 2 0 0 1 2.11-.45c.9.31 1.83.53 2.79.66A2 2 0 0 1 22 16.92z" /></svg>;
    default:
      return null;
  }
}

function NavLink({ section }) {
  return <a href={`#${section.toLowerCase()}`} className="nav-link">{section}</a>;
}

function Section({ id, title, children }) {
  return (
    <section id={id} className="site-section">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

function ButtonLink({ href, children }) {
  const isHashLink = href.startsWith("#");
  return (
    <a href={href} target={isHashLink ? undefined : "_blank"} rel={isHashLink ? undefined : "noreferrer"} className="button-link">
      {children}
    </a>
  );
}

function ScrambleCard({ card }) {
  const [text, setText] = useState(() => jumble(card.encoded));
  const [state, setState] = useState("scrambled"); // scrambled | settling | clear
  const unscramble = () => {
    const target = decodeText(card.encoded);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setText(target); setState("clear"); return; }
    setState("settling");
    const pool = [...target].filter((ch) => !FIXED.test(ch));
    let step = 0;
    const id = setInterval(() => { // characters lock into place left to right; the rest keep shuffling
      step += 1;
      const done = Math.floor(step / 2);
      setText([...target].map((ch, i) => (i < done || FIXED.test(ch) ? ch : pool[Math.floor(Math.random() * pool.length)])).join(""));
      if (done >= target.length) { clearInterval(id); setText(target); setState("clear"); }
    }, 32);
  };
  return (
    <div className="contact-card scramble-card">
      <Icon name={card.icon} className="contact-icon" />
      <span className="contact-label">{card.label}</span>
      <span className={`contact-value scramble-value ${state}`} aria-live="polite">
        <span aria-label={state === "scrambled" ? `${card.label}, scrambled` : undefined}>{text}</span>
      </span>
      {state !== "clear" && <button type="button" className="unscramble" onClick={unscramble} disabled={state === "settling"}>Unscramble</button>}
    </div>
  );
}

function ContactCard({ card }) {
  if (card.encoded) return <ScrambleCard card={card} />;
  const content = <><Icon name={card.icon} className="contact-icon" /><span className="contact-label">{card.label}</span><span className="contact-value">{card.value}</span></>;
  if (!card.href) return <div className="contact-card">{content}</div>;
  return <a className="contact-card" href={card.href} target={card.href.startsWith("mailto:") ? undefined : "_blank"} rel={card.href.startsWith("mailto:") ? undefined : "noreferrer"}>{content}</a>;
}

function Css() {
  return (
    <style>{`
      :root {
        --bg: #1a0f0a;
        --panel: rgba(34, 18, 10, 0.82);
        --line: rgba(255, 180, 120, 0.18);
        --text: #fff2e6;
        --muted: #e6c7a8;
        --dim: #b08b6b;
        --accent: #ffb36b;
        --accent-soft: #ffd9b3;
        --blue: #ff9a4d;
        --cyan: #ffd4a3;
        --shadow: rgba(0, 0, 0, 0.6);
      }

      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body { margin: 0; }
      .site-root button, .site-root input, .site-root select, .site-root textarea, .site-root code { font-family: inherit; }

      .site-root {
        position: relative;
        min-height: 100vh;
        color: var(--text);
        background:
          radial-gradient(circle at 50% 0%, rgba(255,160,90,0.10), transparent 28rem),
          linear-gradient(180deg, #160a06 0%, #1a0f0a 45%, #0f0705 100%);
        font-family: "Playfair Display", Georgia, "Times New Roman", Times, serif;
        overflow-x: hidden;
      }

      .bg-scroll-layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 0;
        opacity: 0.78;
        background-image:
          ${starTiles.page.image};
        background-size: ${starTiles.page.size};
        background-position: center;
        filter: drop-shadow(0 0 3px rgba(255,210,170,0.35));
        animation: pageStarTwinkle 1.6s linear infinite;
        will-change: opacity;
      }
      .bg-scroll-layer::after {
        content: "";
        position: absolute;
        inset: 0;
        background-image: ${starFields.front};
        background-size: 100% 100%;
        background-position: center;
        opacity: 0.52;
        filter: drop-shadow(0 0 8px rgba(255,235,215,0.5));
        animation: pageStarTwinkleBright 1.2s linear infinite;
        will-change: opacity;
      }

      /* Twinkles animate opacity only: animating filter re-draws every star gradient each frame (very slow on
         phones), while opacity is composited on the GPU and each star layer is drawn once. */
      @keyframes pageStarTwinkle {
        0%, 100% { opacity: 0.70; } 10% { opacity: 0.76; } 20% { opacity: 0.68; } 30% { opacity: 0.79; } 40% { opacity: 0.73; }
        50% { opacity: 0.81; } 60% { opacity: 0.71; } 70% { opacity: 0.78; } 80% { opacity: 0.72; } 90% { opacity: 0.80; }
      }
      @keyframes pageStarTwinkleBright {
        0%, 100% { opacity: 0.45; } 15% { opacity: 0.56; } 30% { opacity: 0.49; } 45% { opacity: 0.64; }
        60% { opacity: 0.52; } 75% { opacity: 0.61; } 90% { opacity: 0.50; }
      }
      @keyframes twinkleFarBack { 0%, 100% { opacity: 0.56; } 50% { opacity: 0.98; } }
      @keyframes twinkleMidBack { 0%, 100% { opacity: 0.64; } 50% { opacity: 1; } }
      @keyframes twinkleMid { 0%, 100% { opacity: 0.70; } 50% { opacity: 1; } }
      @keyframes twinkleBack { 0%, 100% { opacity: 0.76; } 50% { opacity: 1; } }
      @keyframes twinkleFront { 0%, 100% { opacity: 0.86; } 50% { opacity: 1; } }
      @keyframes twinkleUltraFront { 0%, 100% { opacity: 0.90; } 50% { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .bg-scroll-layer, .bg-scroll-layer::after, .starfield { animation: none !important; }
      }
      @keyframes riseIn { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes navDrop { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }

      .topbar {
        position: sticky;
        top: 0;
        z-index: 20;
        border-bottom: 1px solid var(--line);
        background: rgba(28, 14, 8, 0.84);
        backdrop-filter: blur(16px);
        animation: navDrop 0.7s ease both;
      }
      .topbar-inner {
        width: min(1120px, calc(100% - 32px));
        margin: 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 14px 0;
      }
      .brand { display: flex; align-items: center; gap: 12px; color: var(--text); text-decoration: none; }
      .brand-mark {
        width: 54px;
        height: 54px;
        border-radius: 0;
        object-fit: cover;
        object-position: 52% 34%;
        transform: scale(1.05);
        box-shadow: 0 0 16px rgba(255,170,100,0.22);
        transition: transform 180ms ease, filter 180ms ease, box-shadow 180ms ease;
        -webkit-box-reflect: below 3px linear-gradient(transparent 58%, rgba(255,255,255,0.18));
      }
      .brand:hover .brand-mark { transform: scale(1.05); filter: brightness(1.08); box-shadow: 0 0 24px rgba(255,190,120,0.28); }
      .brand-title { font-size: 1.05rem; font-weight: 700; letter-spacing: 0.03em; }
      .brand-subtitle { color: var(--muted); font-size: 0.75rem; margin-top: 2px; }
      .nav { display: flex; gap: 6px; }
      .nav-link { color: var(--muted); text-decoration: none; padding: 9px 13px; border-radius: 0; font-size: 0.86rem; transition: 180ms ease; }
      button.nav-link { font-family: inherit; background: transparent; border: 0; cursor: pointer; line-height: 1.4; }
      .nav-link:hover { color: #2a1208; background: var(--accent-soft); box-shadow: 0 0 22px rgba(255,170,100,0.35); }

      .projects-intro { text-align: center; padding: 40px 0 6px; }
      .page-title { color: #fff2e6; font-size: clamp(2.6rem, 6vw, 4.4rem); line-height: 0.95; letter-spacing: -0.05em; margin: 0; text-shadow: 0 0 44px rgba(255,170,100,0.25); }
      .page-lead { max-width: 640px; margin: 16px auto 0; text-align: center; }
      .project-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; padding: 34px 0 10px; }
      .project-card { display: flex; flex-direction: column; color: inherit; text-decoration: none; transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease; animation: riseIn 0.8s ease both; }
      .project-card:hover, .project-card:focus-visible { transform: translateY(-4px); border-color: rgba(255,180,120,0.55); box-shadow: 0 26px 70px var(--shadow), 0 0 32px rgba(255,170,100,0.16); outline: none; }
      .project-art-wrap { border-bottom: 1px solid var(--line); background: radial-gradient(120% 90% at 50% 0%, rgba(255,154,77,0.14), rgba(20,10,6,0.6)); padding: 16px 18px 10px; }
      .project-art { display: block; width: 100%; height: auto; }
      .project-card-body { display: flex; flex-direction: column; gap: 12px; padding: 20px 22px 22px; flex: 1; }
      .project-title { margin: 0; color: #fff2e6; font-size: 1.45rem; letter-spacing: -0.02em; }
      .project-blurb { margin: 0; color: var(--muted); font-size: 0.97rem; line-height: 1.7; flex: 1; }
      .project-tags { display: flex; flex-wrap: wrap; gap: 6px; }
      .project-tags span { border: 1px solid var(--line); color: var(--dim); font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 8px; }
      .project-open { align-self: flex-start; font-family: inherit; font-weight: 700; font-size: 0.86rem; color: #000; background: linear-gradient(180deg, #ffe2c2, var(--blue)); padding: 10px 16px; box-shadow: 0 0 22px rgba(255,154,77,0.28); }
      .project-card:hover .project-open { filter: brightness(1.06); }
      .back-link { display: inline-flex; gap: 8px; margin: 34px 0 0; color: var(--muted); text-decoration: none; font-size: 0.92rem; border-bottom: 1px solid transparent; }
      .back-link:hover { color: var(--accent-soft); border-bottom-color: var(--line); }
      .nav-link.active { color: #fff2e6; box-shadow: inset 0 -2px 0 var(--accent); }
      .menu-btn { display: none; flex-direction: column; justify-content: center; gap: 5px; width: 44px; height: 44px; padding: 0 11px; background: transparent; border: 1px solid var(--line); cursor: pointer; }
      .menu-btn span { display: block; height: 2px; background: var(--text); transition: transform 180ms ease, opacity 180ms ease; }
      .menu-btn.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
      .menu-btn.open span:nth-child(2) { opacity: 0; }
      .menu-btn.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
      .menu-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

      .hero {
        position: relative;
        z-index: 1;
        width: min(1120px, calc(100% - 32px));
        min-height: 52vh;
        margin: 0 auto;
        display: flex;
        align-items: center;
        padding: 44px 0 32px;
      }
      .hero-cards {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        width: 100%;
        height: 400px;
        align-items: stretch;
      }
      .hero::before { content: none; }
      .hero-card {
        position: relative;
        padding: 10;
        border: 1px solid rgba(255,180,120,0.22);
        overflow: hidden;
        height: 100%;
      }
      .image-card {
        display: flex;
        align-items: stretch;
        height: 100%;
      }
      .hero-image {
        width: 100%;
        height: 100%;
        max-height: 100%;
        object-fit: cover;
        object-position: 30% 50%;
      }
      .content-card {
        padding: clamp(24px, 4vw, 44px);
        background: rgba(30, 14, 8, 0.82);
        display: flex;
        flex-direction: column;
        justify-content: center;
        overflow: hidden;
        perspective: 1800px;
      }
      .starfield {
        position: absolute;
        inset: 0;
        pointer-events: none;
        transition: transform 320ms ease-out;
        will-change: opacity, transform;
      }
      .starfield-farback {
        animation: twinkleFarBack 5.8s ease-in-out infinite;
        z-index: 0;
        transform: translate3d(calc(var(--star-x, 0px) * -18), calc(var(--star-y, 0px) * -18), 0) scale(1.05);
        background-image: ${starTiles.farBack.image};
        background-size: ${starTiles.farBack.size};
        background-position: center;
      }
      .starfield-midback {
        animation: twinkleMidBack 5.2s ease-in-out infinite;
        z-index: 1;
        transform: translate3d(calc(var(--star-x, 0px) * -26), calc(var(--star-y, 0px) * -26), 0) scale(1.07);
        background-image: ${starTiles.midBack.image};
        background-size: ${starTiles.midBack.size};
        background-position: center;
      }
      .starfield-mid {
        animation: twinkleMid 4.6s ease-in-out infinite;
        z-index: 2;
        transform: translate3d(calc(var(--star-x, 0px) * -34), calc(var(--star-y, 0px) * -34), 0) scale(1.09);
        background-image: ${starTiles.mid.image};
        background-size: ${starTiles.mid.size};
        background-position: center;
      }
      .starfield-back {
        animation: twinkleBack 5.0s ease-in-out infinite;
        z-index: 1;
        transform: translate3d(calc(var(--star-x, 0px) * -42), calc(var(--star-y, 0px) * -42), 0) scale(1.10);
        background-image: ${starTiles.back.image};
        background-size: ${starTiles.back.size};
        background-position: center;
      }
      .starfield-front {
        animation: twinkleFront 3.8s ease-in-out infinite;
        z-index: 6;
        transform: translate3d(calc(var(--star-x, 0px) * 74), calc(var(--star-y, 0px) * 74), 0) scale(1.16);
        filter: drop-shadow(0 0 3px rgba(255,255,255,0.75));
        background-image: ${starFields.front};
        background-size: 100% 100%;
        background-position: center;
      }
      .starfield-ultrafront {
        animation: twinkleUltraFront 2.9s ease-in-out infinite;
        z-index: 7;
        transform: translate3d(calc(var(--star-x, 0px) * 140), calc(var(--star-y, 0px) * 140), 0) scale(1.22);
        filter: drop-shadow(0 0 18px rgba(255,255,255,1)) drop-shadow(0 0 8px rgba(255,255,255,0.95));
        background-image: ${starFields.ultraFront};
        background-size: 100% 100%;
        background-position: center;
      }
      .content-foreground {
        position: relative;
        z-index: 3;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: center;
        text-align: center;
        isolation: isolate;
        transform-style: preserve-3d;
        transform: perspective(900px) rotateX(calc(var(--tilt-y, 0deg) * -1)) rotateY(var(--tilt-x, 0deg));
        transform-origin: 50% 50%;
        transition: transform 180ms ease-out, filter 180ms ease-out;
        will-change: transform;
        filter: drop-shadow(calc(var(--plane-shadow-x, 0px) * -0.18) calc(var(--plane-shadow-y, 0px) * -0.18) 10px rgba(30,14,8,0.55));
      }
      .content-foreground > * {
        position: relative;
        z-index: 3;
        transform: translateZ(34px);
        text-shadow: 0 2px 16px rgba(30, 14, 8, 0.95), 0 0 24px rgba(30, 14, 8, 0.8);
      }
      .content-foreground .hero-actions { transform: translateZ(34px); }
      .eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: 0.24em; font-size: 0.79rem; font-weight: 700; margin-bottom: 18px; }
      .hero-title {
        margin: 0;
        width: 100%;
        font-size: clamp(3.6rem, 7vw, 7rem);
        line-height: 0.88;
        letter-spacing: -0.055em;
        color: #fff2e6;
        text-shadow: 0 0 44px rgba(255,170,100,0.25);
      }
      .hero-subtitle { margin: 18px 0 0; width: 100%; color: var(--muted); font-size: clamp(1.05rem, 2vw, 1.35rem); }
      .hero-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 26px; }

      .lazy-graphic {
        width: 100%;
        min-height: 160px;
        display: grid;
        place-items: center;
        gap: 6px;
        border: 1px solid rgba(255,170,100,0.24);
        background: linear-gradient(180deg, rgba(30,14,8,0.82), rgba(20,10,6,0.92));
        color: #fff2e6;
        font: inherit;
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        transition: border-color 180ms ease, filter 180ms ease;
      }
      .lazy-graphic:hover { border-color: rgba(255,255,255,0.6); filter: brightness(1.12); }
      .lazy-graphic span { font-size: 0.86rem; font-weight: 800; }
      .lazy-wide { min-height: 260px; border: 0; border-bottom: 1px solid var(--line); }
      .lazy-graphic small { color: var(--muted); font-size: 0.7rem; letter-spacing: 0.18em; }

      .content { position: relative; z-index: 1; width: min(900px, calc(100% - 32px)); margin: 0 auto; padding: 12px 0 76px; }
      .site-section { scroll-margin-top: 100px; border-top: 1px solid var(--line); padding: 58px 0; animation: riseIn 0.8s ease both; }
      .section-title { color: #fff2e6; font-size: clamp(2rem, 5vw, 3.2rem); line-height: 1; letter-spacing: -0.045em; margin: 0 0 28px; text-align: center; }
      .panel { background: linear-gradient(180deg, rgba(42,20,10,0.88), rgba(22,10,6,0.9)); border: 1px solid var(--line); border-radius: 0; box-shadow: 0 22px 70px var(--shadow); overflow: hidden; }
      .panel-body { padding: clamp(22px, 4vw, 34px); }
      .prose { color: var(--muted); font-size: 1.04rem; line-height: 1.85; }
      .prose p { margin: 0 0 18px; }
      .prose a { color: var(--cyan); text-decoration: none; border-bottom: 1px solid rgba(255,170,100,0.42); }
      .prose a:hover { border-bottom-color: var(--cyan); }
      .prose a.button-link, .prose a.button-link:hover { color: #000000; border-bottom: 0; } /* buttons inside prose keep button styling */
      .intro-image-frame { width: 100%; margin: 0 auto; overflow: visible; border-bottom: 1px solid var(--line); background: rgba(30,14,8,0.72); }
      .profile-image { width: 100%; height: auto; display: block; object-fit: contain; object-position: center; filter: contrast(1.05) saturate(0.98); }
      .galaxy-gif { width: 100%; display: block; background: #160a06; }
      .button-link {
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        gap: 9px;
        color: #000000;
        background: linear-gradient(180deg, #ffe2c2, var(--blue));
        text-decoration: none;
        border-radius: 0;
        padding: 12px 18px;
        font-size: 0.9rem;
        font-weight: 800;
        box-shadow: 0 10px 28px rgba(255,140,70,0.32);
        transition: 180ms ease;
      }
      .button-link:hover { transform: translateY(-2px); filter: brightness(1.06); }

      .resume-card { display: grid; gap: 18px; }
      .resume-frame-shell {
        border: 1px solid rgba(255,170,100,0.24);
        background: rgba(30,14,8,0.72);
        padding: 10px;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.035), 0 18px 60px rgba(0,0,0,0.34);
      }
      .resume-frame {
        width: 100%;
        height: min(82vh, 980px);
        display: block;
        border: 0;
        background: #1a0f0a;
      }
      .resume-image-link { display: none; }
      .resume-image-link img { width: 100%; height: auto; display: block; }
      @media (max-width: 760px), (hover: none) and (pointer: coarse) { .resume-frame { display: none; } .resume-image-link { display: block; } }
      .dtd-carousel { border-bottom: 1px solid var(--line); outline: none; }
      .dtd-carousel:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }
      .dtd-stage { position: relative; aspect-ratio: 1374 / 1320; max-height: 78vh; margin: 0 auto; background: #fff; }
      .dtd-video, .dtd-load { position: absolute; inset: 0; width: 100%; height: 100%; }
      .dtd-video { object-fit: contain; background: #fff; display: block; }
      .dtd-load { border: 0; cursor: pointer; font: inherit; color: #fff2e6; background-color: #fff; background-size: contain; background-repeat: no-repeat; background-position: center;
        display: grid; place-content: center; gap: 8px; text-transform: uppercase; letter-spacing: 0.12em; }
      .dtd-load::before { content: ""; position: absolute; inset: 0; background: rgba(20,10,6,0.55); transition: background 180ms ease; }
      .dtd-load:hover::before { background: rgba(20,10,6,0.42); }
      .dtd-load span, .dtd-load small { position: relative; background: rgba(20,10,6,0.9); padding: 8px 14px; justify-self: center; }
      .dtd-load span { font-size: 0.86rem; font-weight: 800; border: 1px solid rgba(255,170,100,0.5); }
      .dtd-load small { color: var(--muted); font-size: 0.7rem; letter-spacing: 0.18em; }
      .dtd-arrow { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; width: 40px; height: 56px; border: 1px solid rgba(255,170,100,0.45); background: rgba(20,10,6,0.82); color: #fff2e6; font-family: inherit; font-size: 30px; line-height: 1; cursor: pointer; }
      .dtd-arrow:hover { background: rgba(60,30,14,0.95); border-color: var(--accent); }
      .dtd-arrow.prev { left: 8px; } .dtd-arrow.next { right: 8px; }
      .dtd-caption { padding: 14px clamp(22px, 4vw, 34px) 4px; }
      .dtd-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; color: var(--text); }
      .dtd-title b { font-size: 1.08rem; }
      .dtd-rank, .dtd-chi { color: var(--dim); font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; font-variant-numeric: tabular-nums; }
      .dtd-chi { margin-left: auto; text-transform: none; letter-spacing: 0.02em; }
      .dtd-caption p { margin: 6px 0 0; color: var(--muted); font-size: 0.96rem; line-height: 1.7; }
      .dtd-dots { display: flex; justify-content: center; gap: 8px; padding: 12px 0 16px; }
      .dtd-dots button { width: 10px; height: 10px; padding: 0; border: 1px solid rgba(255,170,100,0.6); background: transparent; cursor: pointer; }
      .dtd-dots button.on { background: var(--accent); border-color: var(--accent); }
      .dtd-dots button:hover { border-color: var(--accent-soft); }
      .research-stack { display: grid; gap: 22px; }
      .tag-line { color: var(--dim); font-size: 0.86rem; letter-spacing: 0.08em; text-transform: uppercase; margin: -10px 0 16px; }
      .resume-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }

      .contact-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .contact-card { color: var(--text); text-decoration: none; border: 1px solid var(--line); border-radius: 0; padding: 20px; background: rgba(255,210,160,0.04); transition: 180ms ease; }
      .contact-card:hover { transform: translateY(-2px); background: rgba(255,170,100,0.12); border-color: rgba(255,170,100,0.46); }
      .contact-icon { color: var(--cyan); display: block; margin-bottom: 12px; }
      .contact-label { display: block; font-weight: 800; }
      .contact-value { display: block; color: var(--muted); margin-top: 3px; }
      .scramble-card { position: relative; }
      .scramble-value { font-variant-ligatures: none; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; padding-right: 7.5em; white-space: pre-wrap; }
      .scramble-value.scrambled { color: var(--dim); letter-spacing: 0.04em; user-select: none; }
      .scramble-value.settling { color: var(--accent-soft); }
      .scramble-value.clear { color: var(--muted); user-select: text; }
      .unscramble { position: absolute; right: 16px; bottom: 16px; font-family: inherit; font-weight: 600; font-size: 13px; line-height: 1; color: var(--bg); background: var(--accent); border: 1px solid var(--accent); border-radius: 0; padding: 7px 10px; cursor: pointer; letter-spacing: 0.02em; }
      .unscramble:hover { background: var(--accent-soft); }
      .unscramble:disabled { opacity: 0.6; cursor: default; }
      @media (max-width: 520px) { .scramble-value { padding-right: 0; } .unscramble { position: static; margin-top: 10px; } }

      .graphics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: center; }
      .graphics-grid.old { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .graphic-tile { display: grid; place-items: center; min-height: 160px; border-radius: 0; border: 1px solid var(--line); background: radial-gradient(circle at 50% 40%, rgba(255,170,100,0.10), rgba(255,220,180,0.03)); overflow: hidden; }
      .graphic-tile img { max-width: 100%; height: auto; display: block; }
      .subheading { color: #fff2e6; font-size: 1.45rem; margin: 0 0 18px; }
      .divider { height: 1px; background: var(--line); margin: 34px 0; }
      .footer { position: relative; z-index: 1; border-top: 1px solid var(--line); color: var(--dim); text-align: center; padding: 28px 16px; font-size: 0.86rem; background: rgba(9,10,13,0.7); }

      @media (max-width: 860px) {
        .topbar { backdrop-filter: none; -webkit-backdrop-filter: none; background: rgba(28, 14, 8, 0.97); }
        .menu-btn { display: flex; }
        .nav { display: none; }
        .nav.open {
          display: flex;
          flex-direction: column;
          gap: 0;
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          padding: 6px 16px 12px;
          background: #1c0e08;
          border-bottom: 1px solid var(--line);
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
        }
        .nav.open .nav-link { padding: 13px 4px; font-size: 1.02rem; border-bottom: 1px solid rgba(255,180,120,0.10); }
        .nav.open .nav-link:last-child { border-bottom: 0; }
        .hero { min-height: auto; padding-top: 54px; }
        .hero-cards {
          grid-template-columns: 1fr;
          height: auto;
        }
        /* stacked: the photo keeps a fixed height; the text card grows to fit its content */
        .image-card { min-height: 360px; height: 360px; }
        .content-card { min-height: 360px; height: auto; }
        .hero::before { inset: 0 -16px; }
        .resume-card { align-items: flex-start; flex-direction: column; }

        .content-foreground {
          transform: perspective(900px) rotateX(calc(var(--tilt-y, 0deg) * -0.55)) rotateY(calc(var(--tilt-x, 0deg) * 0.55));
        }

        .starfield-farback,
        .starfield-midback {
          opacity: 0.42;
        }

        .starfield-mid,
        .starfield-back {
          opacity: 0.58;
        }

        .starfield-front,
        .starfield-ultrafront {
          opacity: 0.66;
        }

        .button-link {
          padding: 14px 22px;
          font-size: 1rem;
        }

        .nav-link {
          padding: 12px 16px;
        }
      }
      @media (max-width: 620px) {
        .hero { min-height: auto; padding-top: 54px; }
        .hero-cards { grid-template-columns: 1fr; height: auto; }
        .image-card { min-height: 0; height: min(360px, 95vw); }
        .content-card { min-height: 0; height: auto; }
        .hero::before { inset: 0 -16px; }
        .resume-card { align-items: flex-start; flex-direction: column; }
        .contact-grid, .graphics-grid, .graphics-grid.old { grid-template-columns: 1fr; }
        .brand-subtitle { display: none; }
        .hero-title { font-size: clamp(3rem, 16vw, 5rem); }
        .content-card { padding: 24px; }
      }
    `}</style>
  );
}

function HomePage() {
  // Mouse-only parallax/tilt. Writes CSS variables straight onto the card once per frame (no React
  // re-render per mouse move). Touch is left alone: on a phone a drag over the card is a scroll.
  const cardRef = useRef(null);
  const frame = useRef(0);
  const setParallax = (x, y) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const st = cardRef.current?.style;
      if (!st) return;
      st.setProperty("--star-x", `${x}px`);
      st.setProperty("--star-y", `${y}px`);
      st.setProperty("--tilt-x", `${x * 8}deg`);
      st.setProperty("--tilt-y", `${y * 8}deg`);
      st.setProperty("--plane-shadow-x", `${x * 18}px`);
      st.setProperty("--plane-shadow-y", `${y * 18}px`);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const handleStarParallax = (event) => {
    if (event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    setParallax(((event.clientX - rect.left) / rect.width - 0.5) * 2, ((event.clientY - rect.top) / rect.height - 0.5) * 2);
  };
  const resetStarParallax = (event) => { if (event.pointerType === "mouse") setParallax(0, 0); };

  return (
    <>
      <section className="hero">
        <div className="hero-cards">
          <motion.div className="hero-card image-card" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8 }}>
            <img src={assets.pfp} alt="Preet Patel" className="hero-image" />
          </motion.div>

          <motion.div
            className="hero-card content-card"
            ref={cardRef}
            onPointerMove={handleStarParallax}
            onPointerLeave={resetStarParallax}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9 }}
          >
            <div className="starfield starfield-farback" />
            <div className="starfield starfield-midback" />
            <div className="starfield starfield-mid" />
            <div className="starfield starfield-back" />
            <div className="content-foreground">
              <p className="eyebrow">M.Sc. in Physics & Astronomy</p>
              <h1 className="hero-title">Preet<br />Patel</h1>
              <p className="hero-subtitle">Astrophysics | Data | AI</p>

              <div className="hero-actions">
                <ButtonLink href="#contact">Contact</ButtonLink>
                <ButtonLink href="#research">Research</ButtonLink>
                <ButtonLink href={`${base}/assets/Resume_public.pdf`}>Resume</ButtonLink>
              </div>
            </div>

            <div className="starfield starfield-front" />
            <div className="starfield starfield-ultrafront" />
          </motion.div>
        </div>
      </section>

      <div className="content">
        <Section id="intro" title="Intro">
          <div className="panel">
            <div className="intro-image-frame">
              <img src={assets.introImg} alt="Intro image" className="profile-image" />
            </div>
            <div className="panel-body prose">
              <p>Hello! I am a scientist with a strong background in math, statistics, programming, and technical communication. I honed these skills as an astrophysicist and during my Master's degree in Physics at UC Davis, alongside my dual-Bachelor's in Physics and in Astronomy from the University of Michigan, Ann Arbor (go blue!).</p>
              <p>While Astrophysics has long been a passion of mine, I have always been intrigued by using data-driven methods to glean insight into the many processes in our world.</p>
              <p>In physics, we use models derived from the laws that govern reality to converge on a solution and extract insights from large collections of data. This makes data science and quantitative analytics a natural fit for my background, and I now seek to expand this knowledge-generating process into industry.</p>
            </div>
          </div>
        </Section>

        <Section id="research" title="Research">
          <div className="research-stack">
          <div className="panel">
            <DtdCarousel />
            <div className="panel-body prose">
              <h3 className="subheading">Reading the Type Ia Supernova Clock from Milky Way Stars</h3>
              <p className="tag-line">2026 · Bayesian inference · MCMC · FIRE element tracers · APOGEE DR17</p>
              <p>Type Ia supernovae enrich stars with iron, but how long after star formation they explode (their delay-time distribution) is still uncertain. I built a Bayesian inference pipeline, in my <a href="https://github.com/patelpb96/GizmoElementTracers" target="_blank" rel="noreferrer">GizmoElementTracers</a> fork of the FIRE analysis code, that turns a proposed delay-time distribution into predicted stellar [Mg/Fe] versus [Fe/H] using the element-tracer method, then compares that prediction to real Milky Way disk stars from APOGEE DR17.</p>
              <p>The comparison works on a summary of the data: each of the Milky Way's two disk sequences (the high-alpha thick disk and the low-alpha thin disk) is described by a mean and spread in both abundances. Every fit holds the total number of Type Ia explosions fixed, so a model can only move explosions in time, never add or remove them, and each run starts the simulation one standard deviation away from the Milky Way so you can watch it walk back.</p>
              <p>I fit ten delay-time-distribution families this way, from the standard power law to a new skewed-peak model, and ranked them. The carousel shows the three best fits. A free-shape version of the Mannucci model, which puts most explosions in a prompt burst within about 50 Myr, fits best; almost every family prefers most explosions at short delays. Differences of a few in χ² are not significant.</p>
              <p>Along the way I wrote a factorized yield integrator that is about 25 times faster than the original numerical integration (agreeing to about one part in a million).</p>
            </div>
          </div>
          <div className="panel">
            <LazyGraphic src={assets.galaxies} alt="Animated simulated low-mass galaxies" className="galaxy-gif" label="Click to load animation" size="2.6 MB" />
            <div className="panel-body prose">
              <h3 className="subheading">Elemental Abundances of Simulated Low-Mass Galaxies</h3>
              <p>For research, I previously focused on the elemental abundances of stars in low-mass dwarf galaxies simulated using <a href="https://fire.northwestern.edu/" target="_blank" rel="noreferrer">FIRE-2</a>.</p>
              <p>In that project, I identified elemental abundance trends, measured in [Mg/Fe] versus [Fe/H], of several galaxies. I found imprints of bursty star formation and satellite accretion in the present-day elemental abundance distributions.</p>
              <p>This work culminated in a first-author publication, accepted by <a href="https://academic.oup.com/mnras" target="_blank" rel="noreferrer">MNRAS</a> in March 2022. The paper can be found on <a href="https://academic.oup.com/mnras/article/512/4/5671/6554259" target="_blank" rel="noreferrer">here</a>.</p>
              <p>My final project involved the new age-tracer module in FIRE-2 and FIRE-3, which allows one to retroactively test multiple models in rates for core-collapse supernovae, type Ia supernovae, and stellar winds without needing to re-run a simulation with altered models. The work above builds directly on it.</p>
            </div>
          </div>
          </div>
        </Section>

        <Section id="resume" title="Resume">
          <div className="panel panel-body resume-card">
            <div className="resume-actions prose">
              <p>My resume, also available as a PDF.</p>
              <ButtonLink href={`${base}/assets/Resume_public.pdf`}>Open PDF</ButtonLink>
            </div>
            <div className="resume-frame-shell">
              <iframe className="resume-frame" src={`${base}/assets/Resume_public.pdf#view=FitH`} title="Preet Patel Resume" />
              {/* phone browsers mostly can't show a PDF inside a page, so they get an image of it that opens the PDF */}
              <a className="resume-image-link" href={`${base}/assets/Resume_public.pdf`} target="_blank" rel="noreferrer">
                <img src={`${base}/images/resume_page.webp`} alt="Preet Patel resume, page 1 (opens the PDF)" loading="lazy" width="1347" height="1743" />
              </a>
            </div>
          </div>
        </Section>

        <Section id="contact" title="Contact">
          <div className="panel panel-body">
            <div className="contact-grid">
              {contactCards.map((card) => <ContactCard key={card.label} card={card} />)}
            </div>
          </div>
        </Section>
      </div>
    </>
  );
}

function ProjectArt({ kind }) {
  // small line drawings in the site's palette, one per card
  if (kind === "lines") {
    return (
      <svg viewBox="0 0 240 120" className="project-art" aria-hidden="true">
        {[24, 48, 72, 96].map((y) => <line key={y} x1="0" x2="240" y1={y} y2={y} stroke="rgba(255,180,120,0.12)" />)}
        <polyline fill="none" stroke="rgba(255,242,230,0.22)" strokeWidth="1.5" points="0,92 30,80 60,86 90,60 120,70 150,52 180,64 210,40 240,48" />
        <polyline fill="none" stroke="#ff9a4d" strokeWidth="2.5" strokeLinejoin="round" points="0,104 24,70 48,44 72,30 96,22 120,18 150,18 180,26 210,52 240,96" />
        <polyline fill="none" stroke="#ffd4a3" strokeWidth="2.5" strokeLinejoin="round" points="0,110 40,100 70,62 100,30 130,20 160,22 190,18 220,24 240,30" />
        <polyline fill="none" stroke="#ffb36b" strokeWidth="2" strokeDasharray="6 5" points="0,88 50,58 100,34 150,26 200,30 240,44" />
      </svg>
    );
  }
  if (kind === "coins") {
    return (
      <svg viewBox="0 0 240 120" className="project-art" aria-hidden="true">
        <polyline fill="none" stroke="rgba(255,180,120,0.35)" strokeWidth="1.5" points="0,96 40,90 80,94 120,70 160,76 200,48 240,40" />
        {[[70, 74], [100, 62], [130, 74]].map(([x, y], k) => (
          <g key={k}>
            <ellipse cx={x} cy={y + 8} rx="26" ry="9" fill="#5a2d14" />
            <ellipse cx={x} cy={y} rx="26" ry="9" fill="#ffb36b" stroke="#ffd9b3" strokeWidth="1.5" />
          </g>
        ))}
        <circle cx="186" cy="40" r="3" fill="#ffd4a3" /><circle cx="204" cy="28" r="2" fill="#ffd4a3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 240 120" className="project-art" aria-hidden="true">
      {[[120, 60, 30], [64, 34, 12], [186, 86, 16], [178, 30, 7], [52, 92, 8]].map(([x, y, r], k) => (
        <path key={k} fill={k ? "#ffd4a3" : "#ff9a4d"} opacity={k ? 0.75 : 1}
          d={`M${x} ${y - r} Q${x + r * 0.18} ${y - r * 0.18} ${x + r} ${y} Q${x + r * 0.18} ${y + r * 0.18} ${x} ${y + r} Q${x - r * 0.18} ${y + r * 0.18} ${x - r} ${y} Q${x - r * 0.18} ${y - r * 0.18} ${x} ${y - r}Z`} />
      ))}
    </svg>
  );
}

function ProjectsPortal() {
  return (
    <div className="content">
      <div className="projects-intro">
        <h1 className="page-title">Projects</h1>
        <p className="page-lead prose">Things I have built: data tools, dashboards and graphics. Pick one to open it.</p>
      </div>
      <div className="project-grid">
        {projects.map((p) => (
          <a key={p.key} href={p.href} className="project-card panel">
            <div className="project-art-wrap"><ProjectArt kind={p.art} /></div>
            <div className="project-card-body">
              <h2 className="project-title">{p.title}</h2>
              <p className="project-blurb">{p.blurb}</p>
              <div className="project-tags">{p.tags.map((t) => <span key={t}>{t}</span>)}</div>
              <span className="project-open">{p.external ? "Open explorer" : "Open"} <span aria-hidden="true">→</span></span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function ProjectPage({ children }) {
  return (
    <div className="content">
      <a href="#/projects" className="back-link"><span aria-hidden="true">←</span> All projects</a>
{children}
    </div>
  );
}

function AlchemyPage() {
  return (
    <ProjectPage>
      <Section id="alchemy" title="Alchemy">
        <div className="panel panel-body">
          <AlchemyDashboard />
        </div>
      </Section>

    </ProjectPage>
  );
}

function GraphicsPage() {
  return (
    <ProjectPage>
      <Section id="graphics" title="Graphics">
        <div className="panel panel-body prose">
          <h3 className="subheading">Animations</h3>
          <p>Here are some of my recent forum signatures. They are web-safe and transparent.</p>
          <div className="graphics-grid">
            {assets.graphics.slice(0, 2).map((src) => <div className="graphic-tile" key={src}><LazyGraphic src={src} alt="Recent transparent animation" /></div>)}
          </div>

          <div className="divider" />
          <h3 className="subheading">Older Animations</h3>
          <div className="graphics-grid old">
            {assets.graphics.slice(2).map((src) => <div className="graphic-tile" key={src}><LazyGraphic src={src} alt="Older animation sample" /></div>)}
          </div>

          <div className="divider" />
          <h3 className="subheading">Links</h3>
          <p>Not too many of these, but feel free to check out my <a href="https://www.deviantart.com/" target="_blank" rel="noreferrer">DeviantArt</a> for some of my older space art. More in progress as we speak.</p>
          <h4 className="subheading">About Me</h4>
          <p>Former Astrophysicist with a long-time passion in graphic design. I spent years trying to figure out how to make GIFs transparent, as it typically looks clunky and lacks smoothness when you try.</p>
          <p>Recently, I figured out that WebP has been adopted by all major browsers as a modern alternative to the GIF format. It works on phones, Mac, and PC, provided the browser is not extremely old.</p>
        </div>
      </Section>
    </ProjectPage>
  );
}

// Minimal hash router: only "#/projects..." paths are routes, so Home's own "#section"
// scroll anchors keep working untouched. No server rewrite needed on GitHub Pages.
const routeOf = (hash) => {
  const m = /^#\/projects(?:\/(alchemy|graphics))?\/?$/.exec(hash || "");
  return m ? (m[1] ? `projects/${m[1]}` : "projects") : "home";
};
function useHashRoute() {
  const [route, setRoute] = useState(() => (typeof window !== "undefined" ? routeOf(window.location.hash) : "home"));
  useEffect(() => {
    const onHash = () => setRoute(routeOf(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0); // a fresh page starts at the top
  }, [route]);
  return route;
}

function Topbar({ route }) {
  // phone-width menu: remembers the page it was opened on, so changing page closes it
  const [menuRoute, setMenuRoute] = useState(null);
  const menuOpen = menuRoute === route;
  const setMenuOpen = (open) => setMenuRoute(open ? route : null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setMenuRoute(null); };
    const onDown = (e) => { if (!e.target.closest(".topbar")) setMenuRoute(null); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [menuOpen]);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a href="#/" className="brand">
          <img src={assets.pfp} alt="Preet Patel profile" className="brand-mark" />
          <div>
            <div className="brand-title">Preet Patel</div>
            <div className="brand-subtitle">Physics • Astronomy • Data Science</div>
          </div>
        </a>
        <button
          type="button"
          className={`menu-btn${menuOpen ? " open" : ""}`}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="primary-nav"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <span /><span /><span />
        </button>
        <nav
          id="primary-nav"
          className={`nav${menuOpen ? " open" : ""}`}
          aria-label="Primary navigation"
          onClick={(e) => { if (e.target.closest("a")) setMenuOpen(false); }}
        >
          {route.startsWith("projects") ? (
            <>
              <a href="#/" className="nav-link">Home</a>
              <a href="#/projects" className={`nav-link${route === "projects" ? " active" : ""}`}>Projects</a>
              {projects.map((p) => (
                <a key={p.key} href={p.href} className={`nav-link${route === `projects/${p.key}` ? " active" : ""}`}>{p.key === "atp" ? "Tennis" : p.title}</a>
              ))}
            </>
          ) : (
            <>
              {sections.map((section) => <NavLink key={section} section={section} />)}
              <a href="#/projects" className="nav-link">Projects</a>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export default function PreetPatelSite() {
  const route = useHashRoute();
  return (
    <main className="site-root">
      <Css />
      <div className="bg-scroll-layer" />
      <Topbar route={route} />
      {route === "projects" ? <ProjectsPortal /> : route === "projects/alchemy" ? <AlchemyPage /> : route === "projects/graphics" ? <GraphicsPage /> : <HomePage />}
      <footer className="footer">© Preet Patel. Graphics: Preet Patel. Layout recreated in React. Built (nearly) in full with Agentic Coding.</footer>
    </main>
  );
}
