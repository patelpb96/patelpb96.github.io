import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import GatewayView from "./Gateway.jsx";
import { marked } from "marked";

// Same origin the page was served from (patelpb.com, GitHub Pages or the dev server).
const base = typeof window !== "undefined" ? window.location.origin : "https://patelpb.com";

const assets = {
  bg: `${base}/bg.jpg`,
  bgGif: `${base}/assets/bg.gif`,
  // Top-bar picture, shown at 54px: a 162px-wide copy (~9 kB) of public/pfp.webp (1200px, ~230 kB), same
  // aspect ratio so .brand-mark's object-position crop is unchanged. Regenerate it if pfp.webp changes.
  pfpSmall: `${base}/pfp_small.webp`,
  pfpFace: `${base}/pfp_face.webp`, // 480px square face crop from the full-resolution original, for the hero
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
const sections = [
  { id: "intro", label: "Intro" },
  { id: "research", label: "Research" },
  { id: "resume", label: "Resume/CV" },
  { id: "contact", label: "Contact" },
];

// The Resume/CV section shows one document at a time; the resume is the default.
const cvDocs = [
  { key: "resume", label: "Resume", pdf: `${base}/assets/Resume_public.pdf`, page: `${base}/images/resume_page.webp`, h: 1743 },
  { key: "cv", label: "CV", pdf: `${base}/assets/CV_public.pdf`, page: `${base}/images/cv_page.webp`, h: 1744 },
];
// Intro section timeline: [when, what], oldest first.
const introTimeline = [
  ["2019", "I graduate from the University of Michigan, Ann Arbor, with a dual BSc in Physics and Astronomy & Astrophysics with a minor in stats."],
  ["2020–2023", "I am a computational astrophysics researcher as a grad student at UC Davis, publishing my own first author research in MNRAS with my hands in multiple projects."],
  ["2023", "I graduate from UC Davis and start working in AI Evaluations."],
  ["2024", "I begin work at the USPTO as a patent examiner in physics."],
  ["To present", "Multiple projects for Mercor helping train AI models with evals and writing."],
];
const projects = [
  {
    key: "atp",
    title: "ATP Top 20 Explorer",
    href: "/projects/atp/",
    external: true,
    tags: ["Tennis", "Data viz", "Python · polars"],
    art: "lines",
  },
  {
    key: "alchemy",
    title: "Alchemy",
    href: "/projects/alchemy/",
    external: true,
    cta: "Open dashboard",
    tags: ["Dashboard", "Live data"],
    art: "coins",
  },
  {
    key: "newsroom",
    title: "Agent Report",
    href: "/projects/newsroom/",
    external: true,
    cta: "Open newsroom",
    tags: ["Agents", "Private"],
    art: "newspaper",
  },
  {
    key: "models",
    title: "Model Comparison",
    href: "/projects/models/",
    external: true,
    cta: "Compare models",
    tags: ["AI models", "Benchmarks", "Live data"],
    art: "scatter",
  },
  {
    key: "mindmap",
    title: "Mindmap Studio",
    href: "/projects/mindmap/",
    external: true,
    cta: "Open editor",
    tags: ["Editor", "No build step"],
    art: "mindmap",
  },
  {
    key: "rally",
    title: "Rally",
    href: "/projects/rally/",
    external: true,
    cta: "Play",
    tags: ["Game", "SVG", "No build step"],
    art: "paddles",
  },
  {
    key: "graphics",
    title: "Graphics",
    href: "#/projects/graphics",
    tags: ["Animation", "Design"],
    art: "spark",
  },
  {
    key: "scratch",
    title: "Scratch",
    href: "#/projects/scratch",
    tags: ["Notes", "Drafts"],
    art: "whiteboard",
  },
];

// Scratch files live in public/scratch/<name>.md and are listed here; each opens at #/projects/scratch/<name>.
// `live` entries render a live view instead (gateway: src/Gateway.jsx, written via `npm run gateway`).
const scratchFiles = [
  { name: "template", src: "scratch/template.md" },
  { name: "gateway", live: true },
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
// Each tile is one small SVG picture (a dot per star), not one CSS gradient per star: the browser
// draws the picture once and stamps it, where 83 stacked gradients were each recomputed across the
// whole screen on every repaint (and a phone repaints the fixed layer as its toolbars slide away).
function makeStarTile(count, seed, tilePx, options) {
  const { minSize, maxSize, alpha } = options;
  const stars = Array.from({ length: count }, (_, index) => {
    const i = index + 1;
    const x = 2 + seededRandom(seed + i * 3.1) * 96; // keep clear of the tile edge so no star is cut in half
    const y = 2 + seededRandom(seed + i * 5.3) * 96;
    const size = minSize + seededRandom(seed + i * 7.9) * (maxSize - minSize);
    const opacity = alpha * (0.45 + seededRandom(seed + i * 13.1) * 0.55);
    // the gradient was solid to "size" px and faded out over the next 0.8px: a dot of size + 0.4 matches it
    return `%3Ccircle cx='${((x / 100) * tilePx).toFixed(2)}' cy='${((y / 100) * tilePx).toFixed(2)}' r='${(size + 0.4).toFixed(2)}' fill-opacity='${opacity.toFixed(3)}'/%3E`;
  });
  const svg = `%3Csvg xmlns='http://www.w3.org/2000/svg' width='${tilePx}' height='${tilePx}' fill='%23fff'%3E${stars.join("")}%3C/svg%3E`;
  return { image: `url("data:image/svg+xml,${svg}")`, size: `${tilePx}px ${tilePx}px` };
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
  // The poster is a CSS background, so loading="lazy" can't defer it: hold it back until the carousel is
  // within 600px of the screen. (No IntersectionObserver: show it at once.)
  const rootRef = useRef(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !rootRef.current) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setNear(true); io.disconnect(); } }, { rootMargin: "600px" });
    io.observe(rootRef.current);
    return () => io.disconnect();
  }, [near]);
  return (
    <div className="dtd-carousel" ref={rootRef} role="region" aria-roledescription="carousel" aria-label="APOGEE fits, one per delay-time distribution" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1); }}
      onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => { if (touch.current == null) return; const dx = e.changedTouches[0].clientX - touch.current; touch.current = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }}>
      <div className="dtd-stage">
        {playing
          ? <video key={run.key} className="dtd-video" src={`/videos/dtd/${run.key}.mp4`} poster={poster} controls autoPlay muted loop playsInline title={`${run.name}: MCMC walkers converging on the APOGEE target`} />
          : (
            <button className="dtd-load" type="button" onClick={() => setPlaying(true)} aria-label={`Load the movie for ${run.name}`} style={near ? { backgroundImage: `url(${poster})` } : undefined}>
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

// Resume by default; the CV is the other tab and its PDF only loads once it's picked.
function ResumeCv() {
  const [k, setK] = useState(0);
  const doc = cvDocs[k];
  return (
    <div className="panel panel-body resume-card">
      <div className="doc-tabs" role="tablist" aria-label="Resume or CV">
        {cvDocs.map((d, i) => (
          <button key={d.key} id={`doc-tab-${d.key}`} type="button" role="tab" aria-selected={i === k} aria-controls="doc-panel"
            className={`rule-link doc-tab${i === k ? " on" : ""}`} onClick={() => setK(i)}>
            {d.label}
            <RuleFeet />
          </button>
        ))}
      </div>
      <div className="resume-actions prose">
        <p>Showing my {doc.key === "cv" ? "CV" : "resume"}. Both are also available as PDFs.</p>
        <ButtonLink href={doc.pdf} variant="ruled">Open {doc.label} PDF</ButtonLink>
      </div>
      <div className="resume-frame-shell" id="doc-panel" role="tabpanel" aria-labelledby={`doc-tab-${doc.key}`}>
        <iframe key={doc.key} className="resume-frame" loading="lazy" src={`${doc.pdf}#view=FitH`} title={`Preet Patel ${doc.label}`} />
        {/* phone browsers mostly can't show a PDF inside a page, so they get an image of page 1 that opens the PDF */}
        <a className="resume-image-link" href={doc.pdf} target="_blank" rel="noreferrer">
          <img key={doc.key} src={doc.page} alt={`Preet Patel ${doc.label}, page 1 (opens the PDF)`} loading="lazy" width="1347" height={doc.h} />
        </a>
      </div>
    </div>
  );
}

function assertSiteData() {
  if (typeof console === "undefined" || typeof console.assert !== "function") return;
  console.assert(Array.isArray(sections), "sections should be an array");
  console.assert(sections.length === 4 && sections.every((s) => /^[a-z]+$/.test(s.id) && s.label), "expected four home navigation sections with plain anchor ids");
  console.assert(projects.length > 0 && projects.every((p) => p.title && p.href) && new Set(projects.map((p) => p.key)).size === projects.length, "projects portal should list linked projects with unique keys");
  console.assert(/^https?:\/\//.test(base), "base URL should be absolute");
  console.assert(assets.bg.endsWith("/bg.jpg"), "background image should use the hosted bg image");
  console.assert(assets.pfpSmall === `${base}/pfp_small.webp`, "top-bar picture should use the small pfp copy");
  console.assert(assets.graphics.length >= 5, "graphics section should include newer and older animations");
  console.assert(contactCards.some((card) => card.href?.startsWith("mailto:")), "contact cards should include a mailto link");
  console.assert(contactCards.some((card) => card.encoded && decodeText(card.encoded).includes("199")), "the phone card should carry its (encoded) factorization");
  console.assert(contactCards.every((card) => card.label && card.icon), "each contact card should have a label and icon key");
  console.assert(!contactCards.some((card) => card.label === "Twitter"), "Twitter should not be included");
  console.assert(cvDocs[0].key === "resume" && cvDocs.every((d) => d.pdf.endsWith("_public.pdf") && d.page.endsWith(".webp")), "Resume/CV should default to the resume and point at the hosted public PDFs");
  for (const [name, t] of Object.entries(starTiles)) {
    console.assert(t.image.split("url(").length - 1 === t.size.split(",").length, `${name}: one tile size per star tile`);
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
    case "file":
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
    default:
      return null;
  }
}

function NavLink({ section }) {
  return <a href={`#${section.id}`} className="nav-link">{section.label}</a>;
}

// Front-page intro: plays on at most INTRO_MAX_PLAYS page loads per INTRO_WINDOW_MS, never with
// reduced motion. Lite mode gets a pared-down version (introLiteCss). The CSS is only put in the
// page when it plays.
const INTRO_KEY = "site-intro-plays";
const INTRO_MAX_PLAYS = 3;
const INTRO_WINDOW_MS = 24 * 60 * 60 * 1000;
let introThisLoad = null; // decided once per page load, on the first visit to the home page
let introSpent = false; // set once it has played, so going back to Home in the same load doesn't replay it
function claimIntro() {
  if (introThisLoad === null) {
    introThisLoad = false;
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      try {
        const now = Date.now();
        const saved = JSON.parse(localStorage.getItem(INTRO_KEY) || "[]");
        const plays = (Array.isArray(saved) ? saved : []).filter((t) => typeof t === "number" && now - t < INTRO_WINDOW_MS);
        if (plays.length < INTRO_MAX_PLAYS) { plays.push(now); introThisLoad = true; }
        localStorage.setItem(INTRO_KEY, JSON.stringify(plays));
      } catch { introThisLoad = true; /* storage blocked: can't count, so just play */ }
    }
  }
  return introThisLoad && !introSpent;
}

// Each letter starts on a golden-angle spiral (137.5° apart, the sunflower-seed pattern) and falls
// into place: the offsets come from the letter's index alone, so every visit plays the same way.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// Only the name at the top of Home plays it. Section titles are plain text: you reach them by
// scrolling, and animating each one as it came into view made the scroll catch on phones.
function IntroTitle({ as: Tag, className, text, play, spread }) {
  const [running, setRunning] = useState(play);
  if (!running) return <Tag className={className}>{text}</Tag>;
  const chars = [...text];
  return (
    // once the last letter lands, go back to plain text so the font's kerning returns
    <Tag className={`${className} split run`} aria-label={text}
      onAnimationEnd={(e) => { if (e.target.dataset.last) setRunning(false); }}>
      {chars.map((c, i) => {
        const a = i * GOLDEN_ANGLE + 0.6;
        const r = spread * (0.8 + 0.3 * Math.sqrt(i + 1));
        return (
          <span key={i} className="ch" aria-hidden="true" data-last={i === chars.length - 1 ? "1" : undefined}
            style={{ "--i": i, "--dx": `${(Math.cos(a) * r).toFixed(3)}em`, "--dy": `${(Math.sin(a) * r).toFixed(3)}em`, "--rot": `${Math.round(((-a * 180) / Math.PI) % 360)}deg` }}>
            {c === " " ? " " : c}
          </span>
        );
      })}
    </Tag>
  );
}

const introCss = `
  .split .ch { display: inline-block; }
  .split.run .ch { animation: introCapture 850ms cubic-bezier(.18,.9,.25,1.12) backwards; animation-delay: calc(var(--d0, 0ms) + var(--i) * 55ms); }
  .hero .split { --d0: 220ms; }
  @keyframes introCapture {
    from { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(.3); color: #9cc3ff; }
    55% { opacity: 1; color: #d8e6ff; }
    to { opacity: 1; transform: none; color: #fff2e6; }
  }
  .hero.intro .hero-face { animation: introLens 900ms cubic-bezier(.2,.8,.2,1) backwards; }
  @keyframes introLens { from { opacity: 0; transform: translateZ(34px) scale(.55) rotate(-14deg); } to { opacity: 1; transform: translateZ(34px); } }
  .hero.intro .eyebrow { animation: introSlit 700ms ease-out 120ms backwards; }
  .hero.intro .hero-subtitle { animation: introSlit 700ms ease-out 1000ms backwards; }
  @keyframes introSlit { from { clip-path: inset(0 50% 0 50%); opacity: .2; } to { clip-path: inset(0 0 0 0); opacity: 1; } }
  .hero.intro .hero-actions > * { animation: introRise 520ms ease-out backwards; }
  .hero.intro .hero-actions > :nth-child(1) { animation-delay: 1200ms; }
  .hero.intro .hero-actions > :nth-child(2) { animation-delay: 1290ms; }
  .hero.intro .hero-actions > :nth-child(3) { animation-delay: 1380ms; }
  @keyframes introRise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  /* one light streak across the card as the name settles */
  .hero.intro .hero-card::after {
    content: ""; position: absolute; z-index: 8; top: -20%; left: 0; width: 38%; height: 140%; pointer-events: none;
    background: linear-gradient(100deg, transparent 40%, rgba(255,226,194,0.32) 50%, transparent 60%);
    transform: translateX(-130%) skewX(-12deg);
    animation: introStreak 1100ms cubic-bezier(.5,0,.3,1) 1050ms both;
  }
  @keyframes introStreak { to { transform: translateX(330%) skewX(-12deg); } }
`;

// Lite intro: same order and stagger, about half as long, opacity and a small rise only. No spin,
// colour shift, clip-path or streak, and no transform on the hero's children (Lite flattens them).
const introLiteCss = `
  .split .ch { display: inline-block; }
  .split.run .ch { animation: introRiseLite 420ms ease-out backwards; animation-delay: calc(var(--d0, 0ms) + var(--i) * 40ms); }
  .hero .split { --d0: 100ms; }
  @keyframes introRiseLite { from { opacity: 0; transform: translateY(0.35em); } to { opacity: 1; transform: none; } }
  .hero.intro .hero-face, .hero.intro .eyebrow { animation: introFadeLite 400ms ease-out backwards; }
  .hero.intro .hero-subtitle { animation: introFadeLite 400ms ease-out 520ms backwards; }
  .hero.intro .hero-actions > * { animation: introFadeLite 400ms ease-out 660ms backwards; }
  @keyframes introFadeLite { from { opacity: 0; } to { opacity: 1; } }
`;

function Section({ id, title, children }) {
  return (
    <section id={id} className="site-section">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

// variant="ruled": hairlines top and bottom with a bracketed serif foot at each corner; the sides draw
// in on hover/focus (CSS .rule-link). The four feet are one shape mirrored by .rule-foot.{tr,bl,br}.
// Resume/CV reuses the look: its two tabs are buttons with the same class and feet.
const RULE_FEET = ["tl", "tr", "bl", "br"];
const RuleFeet = () => RULE_FEET.map((corner) => (
  <svg key={corner} className={`rule-foot ${corner}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M0 0H6.5V1Q1.7 1.2 1 6H0Z" fill="currentColor" />
  </svg>
));

function ButtonLink({ href, children, variant }) {
  const isHashLink = href.startsWith("#");
  const ruled = variant === "ruled";
  return (
    <a href={href} target={isHashLink ? undefined : "_blank"} rel={isHashLink ? undefined : "noreferrer"} className={ruled ? "rule-link" : "button-link"}>
      {children}
      {ruled && <RuleFeet />}
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

      /* The star layer stays put while the page scrolls. Its height is the largest the screen gets
         (100lvh), not "inset: 0": on phones the address bar slides away as you scroll, and a layer
         pinned to the visible area would be resized each time, sliding and stretching the centred
         stars and redrawing every one of them (with their glow) mid-scroll. */
      .bg-scroll-layer {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100vh;
        height: 100lvh;
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
      /* The Lite toggle exists twice. Wide: the last item of the navigation, in the top-right corner (the -nav copy).
         Narrow, where the navigation folds into the menu: its own item in the bar, between the name and the menu
         button (the -bar copy). Exactly one is displayed at any width, so the toggle is never inside the phone menu. */
      .topbar-inner > .lite-toggle-bar { display: none; }
      .brand { display: flex; align-items: center; gap: 12px; min-width: 0; color: var(--text); text-decoration: none; }
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
      .project-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; padding: 34px 0 10px; }
      .project-card { display: flex; flex-direction: column; color: inherit; text-decoration: none; transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease; animation: riseIn 0.8s ease both; }
      .project-card:hover, .project-card:focus-visible { transform: translateY(-4px); border-color: rgba(255,180,120,0.55); box-shadow: 0 26px 70px var(--shadow), 0 0 32px rgba(255,170,100,0.16); outline: none; }
      .project-art-wrap { border-bottom: 1px solid var(--line); background: radial-gradient(120% 90% at 50% 0%, rgba(255,154,77,0.14), rgba(20,10,6,0.6)); padding: 16px 18px 10px; }
      .project-art { display: block; width: 100%; height: auto; }
      .project-card-body { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 22px 22px 26px; text-align: center; }
      .project-title { margin: 0; color: #fff2e6; font-size: 1.45rem; letter-spacing: -0.02em; }
      /* the card is one link, so its button is a span: hovering or focusing the card draws the ruled sides in, as hovering a home-page button does */
      .project-card:hover .project-open, .project-card:focus-visible .project-open {
        background-size: 100% 1px, 100% 1px, 1px 50.5%, 1px 50.5%, 1px 50.5%, 1px 50.5%;
        background-color: rgba(255,179,107,0.09);
      }
      .scratch-files { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 18px; margin-bottom: 22px; border-bottom: 1px solid var(--line); }
      .scratch-file { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--line); color: var(--muted); text-decoration: none; font-family: ui-monospace, Consolas, monospace; font-size: 0.9rem; }
      .scratch-file:hover { border-color: rgba(255,180,120,0.55); color: #fff2e6; }
      .scratch-file.on { background: rgba(255,154,77,0.16); border-color: var(--blue); color: #fff2e6; }
      .scratch-doc { overflow-wrap: anywhere; font-size: 0.98rem; line-height: 1.75; }
      .scratch-doc h1, .scratch-doc h2, .scratch-doc h3, .scratch-doc h4 { color: #fff2e6; line-height: 1.3; margin: 1.6em 0 0.6em; }
      .scratch-doc h1 { font-size: 1.6rem; margin-top: 0; }
      .scratch-doc h2 { font-size: 1.35rem; }
      .scratch-doc h3 { font-size: 1.1rem; }
      .scratch-doc ul, .scratch-doc ol { padding-left: 1.4em; margin: 0 0 18px; }
      .scratch-doc li { margin: 4px 0; }
      .scratch-doc strong { color: #fff2e6; }
      .scratch-doc blockquote { margin: 0 0 18px; padding: 4px 0 4px 16px; border-left: 3px solid var(--blue); color: var(--accent-soft); }
      .scratch-doc hr { border: 0; border-top: 1px solid var(--line); margin: 26px 0; }
      .scratch-doc code { font-family: ui-monospace, Consolas, monospace; font-size: 0.88em; background: rgba(255,154,77,0.1); padding: 1px 5px; }
      .scratch-doc pre { overflow-x: auto; background: rgba(0,0,0,0.3); padding: 12px; border: 1px solid var(--line); }
      .scratch-doc pre code { background: none; padding: 0; }
      .scratch-doc table { border-collapse: collapse; display: block; overflow-x: auto; margin: 0 0 18px; }
      .scratch-doc th, .scratch-doc td { border: 1px solid var(--line); padding: 6px 10px; vertical-align: top; }
      .gateway-offline { display: flex; gap: 14px; align-items: flex-start; }
      .gateway-title { margin: 0 0 4px; color: #fff2e6; font-weight: 700; }
      .gateway-offline .gateway-dot { margin-top: 7px; }
      .gateway-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex: none; }
      .gateway-dot.on { background: #5fd38a; box-shadow: 0 0 8px #5fd38a; animation: gateway-pulse 2s ease-in-out infinite; }
      .gateway-dot.off { background: var(--muted); opacity: 0.6; }
      @keyframes gateway-pulse { 50% { opacity: 0.45; } }
      @media (prefers-reduced-motion: reduce) { .gateway-dot.on { animation: none; } }
      .gateway-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
      .gateway-chip { display: inline-flex; align-items: center; gap: 8px; font-family: ui-monospace, Consolas, monospace; font-size: 0.85rem; color: var(--muted); }
      .gateway-unlock { display: grid; gap: 12px; max-width: 460px; }
      .gateway-unlock p { margin: 0; }
      .gateway-err { color: #ff8a7a; }
      .gateway-row { display: flex; gap: 8px; flex-wrap: wrap; }
      .gateway-row input { flex: 1 1 200px; min-width: 0; font: inherit; font-size: 0.95rem; color: var(--text); background: rgba(0,0,0,0.3); border: 1px solid var(--line); padding: 9px 12px; border-radius: 0; }
      .gateway-row input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
      .gateway-go, .gateway-lock { font-family: inherit; font-weight: 600; font-size: 13px; letter-spacing: 0.02em; border-radius: 0; padding: 9px 14px; cursor: pointer; }
      .gateway-go { color: var(--bg); background: var(--accent); border: 1px solid var(--accent); }
      .gateway-go:hover:not(:disabled) { background: var(--accent-soft); }
      .gateway-go:disabled { opacity: 0.6; cursor: default; }
      .gateway-lock { color: var(--muted); background: transparent; border: 1px solid var(--line); padding: 6px 10px; }
      .gateway-actions { display: inline-flex; gap: 8px; }
      .gateway-lock:hover { color: #fff2e6; border-color: rgba(255,180,120,0.55); }
      .back-link { display: inline-flex; gap: 8px; margin: 34px 0 0; color: var(--muted); text-decoration: none; font-size: 0.92rem; border-bottom: 1px solid transparent; }
      .back-link:hover { color: var(--accent-soft); border-bottom-color: var(--line); }
      .nav-link.active { color: #fff2e6; box-shadow: inset 0 -2px 0 var(--accent); }
      .projects-menu { position: relative; display: flex; }
      .projects-trigger { display: inline-flex; align-items: center; gap: 8px; }
      .projects-trigger .caret { width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor; transition: transform 180ms ease; }
      .projects-trigger.open .caret { transform: rotate(180deg); }
      .projects-trigger.open { color: #fff2e6; background: rgba(255,154,77,0.12); }
      .projects-panel {
        position: absolute; top: calc(100% + 10px); right: 0; z-index: 30;
        width: 300px; padding: 10px; border-radius: 0;
        background: #1c0e08; border: 1px solid var(--line); box-shadow: 0 18px 40px rgba(0,0,0,0.5);
      }
      .projects-search {
        width: 100%; box-sizing: border-box; font: inherit; font-size: 0.9rem; color: var(--text);
        background: rgba(0,0,0,0.3); border: 1px solid var(--line); border-radius: 0; padding: 8px 10px;
      }
      .projects-search:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
      /* three rows tall: the first three A–Z show on open, the rest scroll */
      .projects-list { list-style: none; margin: 8px 0 0; padding: 0; max-height: calc(3 * 58px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(255,180,120,0.35) transparent; }
      .projects-item { display: flex; flex-direction: column; justify-content: center; gap: 2px; height: 58px; box-sizing: border-box; padding: 0 10px; text-decoration: none; border-left: 2px solid transparent; }
      .projects-item-title { color: var(--text); font-size: 0.92rem; }
      .projects-item-tags { color: var(--dim); font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .projects-item.hi { background: rgba(255,154,77,0.14); }
      .projects-item.hi .projects-item-title { color: #fff2e6; }
      .projects-item.current { border-left-color: var(--accent); }
      .projects-empty { margin: 10px 4px 4px; color: var(--muted); font-size: 0.86rem; }
      .projects-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 0.78rem; color: var(--dim); }
      .projects-foot a { color: var(--accent-soft); text-decoration: none; }
      .projects-foot a:hover { color: #fff2e6; }
      .menu-btn { display: none; flex-direction: column; justify-content: center; gap: 5px; width: 44px; height: 44px; padding: 0 11px; background: transparent; border: 1px solid var(--line); cursor: pointer; }
      .menu-btn span { display: block; height: 2px; background: var(--text); transition: transform 180ms ease, opacity 180ms ease; }
      .menu-btn.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
      .menu-btn.open span:nth-child(2) { opacity: 0; }
      .menu-btn.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
      .menu-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

      .hero {
        position: relative;
        z-index: 1;
        width: min(900px, calc(100% - 32px)); /* same as .content, so the card lines up with the panels below */
        min-height: 52vh;
        margin: 0 auto;
        display: flex;
        align-items: center;
        padding: 44px 0 32px;
      }
      .hero::before { content: none; }
      /* one card across the full hero width (centered by .hero); the face photo sits in the text plane */
      .hero-card {
        position: relative;
        width: 100%;
        min-height: 400px;
        border: 1px solid rgba(255,180,120,0.22);
        overflow: hidden;
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
      .hero-face {
        align-self: center;
        width: clamp(92px, 10vw, 136px);
        height: auto;
        aspect-ratio: 1;
        object-fit: cover;
        margin: 0 0 20px;
        border: 1px solid rgba(255,190,130,0.6);
        box-shadow: 0 12px 34px rgba(10,4,2,0.6), 0 0 0 4px rgba(30,14,8,0.55);
      }
      .hero-title {
        margin: 0;
        width: 100%;
        white-space: nowrap;
        font-size: clamp(2.5rem, 7vw, 6.4rem);
        line-height: 0.95;
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
      .timeline { margin: 26px 0 0; padding: 0; border-left: 1px solid var(--line); }
      .timeline-row { display: grid; grid-template-columns: 7.5em 1fr; gap: 18px; position: relative; padding: 10px 0 10px 20px; }
      .timeline-row::before { content: ""; position: absolute; left: -4px; top: 21px; width: 7px; height: 7px; background: var(--accent); }
      .timeline dt { color: var(--accent); font-weight: 700; font-size: 0.9rem; letter-spacing: 0.04em; line-height: 1.85; white-space: nowrap; }
      .timeline dd { margin: 0; }
      @media (max-width: 520px) { .timeline-row { grid-template-columns: 1fr; gap: 2px; } }
      .prose a { color: var(--cyan); text-decoration: none; border-bottom: 1px solid rgba(255,170,100,0.42); }
      .prose a:hover { border-bottom-color: var(--cyan); }
      .prose a.button-link, .prose a.button-link:hover { color: #000000; border-bottom: 0; } /* buttons inside prose keep button styling */
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
      /* Hero buttons: ruled lines with bracketed serif ends. Six 1px gradient layers: full top and bottom
         rules, then four side segments (0 high at rest) that grow from each corner to meet mid-height. */
      .rule-link {
        --rl-c: linear-gradient(var(--accent) 0 0);
        position: relative;
        overflow: hidden;
        display: inline-block;
        font-family: inherit;
        font-size: 0.9rem;
        font-weight: 400;
        letter-spacing: 0.04em;
        color: var(--text);
        text-decoration: none;
        text-shadow: 0 1px 10px rgba(30,14,8,0.9);
        border-radius: 0;
        padding: 12px 26px;
        background:
          var(--rl-c) top / 100% 1px, var(--rl-c) bottom / 100% 1px,
          var(--rl-c) top left / 1px 0, var(--rl-c) bottom left / 1px 0,
          var(--rl-c) top right / 1px 0, var(--rl-c) bottom right / 1px 0;
        background-repeat: no-repeat;
        transition: background-size 320ms ease, background-color 320ms ease;
      }
      .rule-link:hover, .rule-link:focus-visible, .rule-link:active {
        background-size: 100% 1px, 100% 1px, 1px 50.5%, 1px 50.5%, 1px 50.5%, 1px 50.5%;
        background-color: rgba(255,179,107,0.09);
      }
      .rule-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
      .rule-foot { position: absolute; width: 16px; height: 16px; pointer-events: none; color: var(--accent); }
      .rule-foot.tl { top: 0; left: 0; }
      .rule-foot.tr { top: 0; right: 0; transform: scaleX(-1); }
      .rule-foot.bl { bottom: 0; left: 0; transform: scaleY(-1); }
      .rule-foot.br { bottom: 0; right: 0; transform: scale(-1); }
      @media (prefers-reduced-motion: reduce) { .rule-link { transition: none; } }

      .resume-card { display: grid; gap: 18px; }
      .doc-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      /* the two tabs wear the hero's ruled-button look (.rule-link); the chosen one keeps its sides drawn in */
      .doc-tab { display: block; width: 100%; border: 0; background-color: transparent; text-align: center; font-size: 1rem; padding: 14px 26px; cursor: pointer; }
      .doc-tab.on { background-size: 100% 1px, 100% 1px, 1px 50.5%, 1px 50.5%, 1px 50.5%, 1px 50.5%; background-color: rgba(255,179,107,0.16); cursor: default; }
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
        /* three things in the bar: name, Lite toggle, menu button. space-between puts the toggle the same
           distance from each neighbour; the gap is the least that distance may be, as a share of the bar's width */
        .topbar-inner { gap: 4%; }
        .topbar-inner > .lite-toggle-bar { display: inline-flex; }
        .nav .lite-toggle-nav { display: none; }
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
        .nav.open .projects-menu { flex-direction: column; }
        .nav.open .projects-trigger { justify-content: space-between; text-align: left; }
        .nav.open .projects-panel { position: static; width: auto; margin: 4px 0 10px; box-shadow: none; }
        .hero { min-height: auto; padding-top: 54px; }
        .hero-card { min-height: 360px; }
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

        .rule-link {
          padding: 14px 26px;
          font-size: 1rem;
        }

        .nav-link {
          padding: 12px 16px;
        }
      }
      @media (max-width: 620px) {
        .hero { min-height: auto; padding-top: 54px; }
        .hero-card { min-height: 0; }
        .hero::before { inset: 0 -16px; }
        .resume-card { align-items: flex-start; flex-direction: column; }
        .contact-grid, .graphics-grid, .graphics-grid.old { grid-template-columns: 1fr; }
        .brand-subtitle { display: none; }
        .hero-title { font-size: clamp(2.2rem, 13vw, 4rem); }
        .content-card { padding: 24px; }
      }

      /* Lite mode (.site-root.lite): same palette, type and still starfield, minus everything the GPU has
         to keep redrawing: twinkle animations, drop-shadow filters on full-screen layers, the blurred
         see-through top bar, the 3D tilt, entrance animations and large soft glows. */
      .lite-toggle { display: inline-flex; align-items: center; gap: 8px; flex: none; }
      .menu-btn { flex: none; }
      .lite-box { width: 11px; height: 11px; border: 1px solid currentColor; flex: none; }
      .lite-toggle.on { color: #fff2e6; }
      .lite-toggle.on .lite-box { background: var(--accent); border-color: var(--accent); box-shadow: inset 0 0 0 2px #1c0e08; }
      .site-root.lite .bg-scroll-layer { animation: none; filter: none; will-change: auto; opacity: 0.6; }
      .site-root.lite .bg-scroll-layer::after { display: none; }
      .site-root.lite .topbar { backdrop-filter: none; -webkit-backdrop-filter: none; background: #1c0e08; animation: none; }
      .site-root.lite .brand-mark { -webkit-box-reflect: unset; box-shadow: none; }
      .site-root.lite .nav-link:hover { box-shadow: none; }
      .site-root.lite .content-card { perspective: none; background: #1e0f09; }
      .site-root.lite .hero-card { border-color: rgba(255,180,120,0.3); box-shadow: inset 0 1px 0 rgba(255,179,107,0.55); }
      .site-root.lite .starfield { animation: none; transition: none; will-change: auto; transform: none; filter: none; }
      .site-root.lite .starfield-farback, .site-root.lite .starfield-midback, .site-root.lite .starfield-mid { display: none; }
      .site-root.lite .starfield-back { opacity: 0.7; }
      .site-root.lite .content-foreground { transform: none; filter: none; transition: none; will-change: auto; transform-style: flat; }
      .site-root.lite .content-foreground > * { transform: none; text-shadow: 0 1px 12px rgba(30,14,8,0.9); }
      .site-root.lite .content-foreground > .hero-actions { text-shadow: none; }
      .site-root.lite .hero-title, .site-root.lite .page-title { text-shadow: 0 1px 12px rgba(30,14,8,0.9), 0 0 28px rgba(255,170,100,0.18); }
      .site-root.lite .hero-face { box-shadow: 0 0 0 4px rgba(30,14,8,0.55); }
      .site-root.lite .site-section, .site-root.lite .project-card { animation: none; }
      .site-root.lite .panel { background: #1d0f08; box-shadow: none; }
      .site-root.lite .button-link, .site-root.lite .project-open, .site-root.lite .resume-frame-shell { box-shadow: none; }
      .site-root.lite .project-card:hover, .site-root.lite .project-card:focus-visible { box-shadow: none; }
      .site-root.lite .gateway-dot.on { animation: none; box-shadow: none; }
    `}</style>
  );
}

function HomePage({ lite }) {
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
  const [intro] = useState(claimIntro);
  useEffect(() => { introSpent = true; }, []);
  useHashLanding();
  const handleStarParallax = (event) => {
    if (event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    setParallax(((event.clientX - rect.left) / rect.width - 0.5) * 2, ((event.clientY - rect.top) / rect.height - 0.5) * 2);
  };
  const resetStarParallax = (event) => { if (event.pointerType === "mouse") setParallax(0, 0); };

  return (
    <>
      {intro && <style>{lite ? introLiteCss : introCss}</style>}
      <section className={`hero${intro ? " intro" : ""}`}>
        <motion.div
          className="hero-card content-card"
          ref={cardRef}
          onPointerMove={lite ? undefined : handleStarParallax}
          onPointerLeave={lite ? undefined : resetStarParallax}
          initial={lite ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9 }}
        >
          <div className="starfield starfield-farback" />
          <div className="starfield starfield-midback" />
          <div className="starfield starfield-mid" />
          <div className="starfield starfield-back" />
          <div className="content-foreground">
            <img src={assets.pfpFace} alt="Preet Patel" className="hero-face" width="480" height="480" />
            <p className="eyebrow">M.Sc. in Physics & Astronomy</p>
            <IntroTitle as="h1" className="hero-title" text="Preet Patel" play={intro} spread={1.6} />
            <p className="hero-subtitle">Astrophysics | Data | AI</p>

            <div className="hero-actions">
              <ButtonLink href="#contact" variant="ruled">Contact</ButtonLink>
              <ButtonLink href="#research" variant="ruled">Research</ButtonLink>
              <ButtonLink href="#resume" variant="ruled">Resume/CV</ButtonLink>
            </div>
          </div>

          <div className="starfield starfield-front" />
          <div className="starfield starfield-ultrafront" />
        </motion.div>
      </section>

      <div className="content">
        <Section id="intro" title="Intro">
          <div className="panel">
            <div className="panel-body prose">
              <p>Welcome to my site! I am a physicist by training with experience in computational astrophysics research (FIRE&#8209;2/3 simulations at UC Davis), AI Evaluation (Google's RMI team, Mercor, Turac, micro1), and Patent Examination in Optics and Photonics.</p>
              <p>I am deeply interested in using rigorous analytical approaches to solving problems, using the toolkits of programming, data science, statistics, and ontology.</p>
              <dl className="timeline">
                {introTimeline.map(([when, what]) => (
                  <div key={when} className="timeline-row"><dt>{when}</dt><dd>{what}</dd></div>
                ))}
              </dl>
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

        <Section id="resume" title="Resume/CV">
          <ResumeCv />
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

// Card art: one detailed line drawing per project, in the site's palette (burnt orange, amber, peach, cream, dark brown).
// All share one 320 x 180 frame. Gradient ids are prefixed per drawing because every drawing sits in the same page.
const ART = { o: "#ff9a4d", a: "#ffb36b", p: "#ffd4a3", c: "#fff2e6", d: "#5a2d14", m: "#b9764a", grid: "rgba(255,180,120,0.14)", ln: "rgba(255,180,120,0.38)" };

// A four-point star.
function Sparkle({ x, y, r, fill, op = 1 }) {
  const k = r * 0.16;
  return <path fill={fill} opacity={op} d={`M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`} />;
}

// A 3 x 5 pixel digit drawn as one path of squares.
const PIXEL_DIGITS = { 2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "111", "001", "111"] };
function PixelDigit({ ch, x, y, s, fill, op = 1 }) {
  const d = PIXEL_DIGITS[ch].flatMap((row, r) => [...row].map((on, c) => (on === "1" ? `M${x + c * s} ${y + r * s}h${s}v${s}h${-s}Z` : ""))).join("");
  return <path d={d} fill={fill} opacity={op} />;
}

function ProjectArt({ kind }) {
  const { o, a, p, c, d, m, grid, ln } = ART;
  const svg = (children, defs) => (
    <svg viewBox="0 0 320 180" className="project-art" aria-hidden="true">
      {defs && <defs>{defs}</defs>}
      {children}
    </svg>
  );

  if (kind === "lines") {
    // ATP: career-ranking curves over a chart with a brushed time window, and a tennis ball
    const curves = [
      ["30,140 56,104 84,66 112,42 140,30 170,28 200,36 230,62 262,98 300,132", o, 3],
      ["30,150 66,132 100,92 134,54 164,36 196,30 226,34 262,48 300,58", p, 2.5],
      ["30,128 60,118 92,122 122,98 152,88 184,92 214,70 246,62 278,56 306,44", c, 1.5],
    ];
    return svg(
      <>
        {[36, 66, 96, 126].map((y) => <line key={y} x1="30" x2="306" y1={y} y2={y} stroke={grid} />)}
        {[70, 130, 190, 250].map((x) => <line key={x} x1={x} x2={x} y1="18" y2="150" stroke={grid} />)}
        <line x1="30" y1="150" x2="306" y2="150" stroke={ln} strokeWidth="1.5" />
        <line x1="30" y1="14" x2="30" y2="150" stroke={ln} strokeWidth="1.5" />
        {[70, 130, 190, 250].map((x) => <line key={`t${x}`} x1={x} x2={x} y1="150" y2="155" stroke={ln} />)}
        <rect x="118" y="18" width="84" height="132" fill="rgba(255,154,77,0.1)" stroke={ln} strokeDasharray="4 4" />
        <rect x="114" y="78" width="8" height="14" fill={a} /><rect x="198" y="78" width="8" height="14" fill={a} />
        {curves.map(([pts, stroke, w]) => <polyline key={stroke} fill="none" stroke={stroke} strokeWidth={w} strokeLinejoin="round" points={pts} />)}
        <path d="M30 132 C 90 120, 120 60, 170 52 S 260 70, 306 70" fill="none" stroke={a} strokeWidth="2" strokeDasharray="6 5" />
        <rect x="296" y="128" width="8" height="8" fill={o} stroke={p} /><rect x="296" y="54" width="8" height="8" fill={p} stroke={o} />
        <ellipse cx="264" cy="152" rx="20" ry="4" fill="rgba(0,0,0,0.35)" />
        <circle cx="264" cy="128" r="19" fill="url(#pa-ball)" stroke={p} strokeWidth="1.5" />
        <path d="M250 117 Q262 128 250 139" fill="none" stroke={d} strokeWidth="2" />
        <path d="M278 117 Q266 128 278 139" fill="none" stroke={d} strokeWidth="2" />
      </>,
      <radialGradient id="pa-ball" cx="35%" cy="30%" r="80%"><stop offset="0" stopColor="#ffe2c2" /><stop offset="0.55" stopColor={a} /><stop offset="1" stopColor={o} /></radialGradient>,
    );
  }

  if (kind === "coins") {
    // Alchemy: price-history candles behind stacks of gold, a flame over the tallest (high alchemy)
    const candles = [118, 110, 114, 100, 104, 92, 96, 84, 88, 72, 78, 64, 70, 56];
    const stacks = [[84, 5], [160, 8], [236, 4]];
    return svg(
      <>
        {[50, 80, 110].map((y) => <line key={y} x1="14" x2="306" y1={y} y2={y} stroke={grid} />)}
        {candles.map((y, i) => (
          <g key={i} opacity="0.55">
            <line x1={26 + i * 20} x2={26 + i * 20} y1={y - 14} y2={y + 16} stroke={a} />
            <rect x={21 + i * 20} y={y - 6 + (i % 3) * 2} width="10" height={10 + (i % 4) * 3} fill={i % 3 ? o : d} stroke={a} strokeWidth="1" />
          </g>
        ))}
        <line x1="14" y1="158" x2="306" y2="158" stroke={ln} strokeWidth="1.5" />
        {stacks.map(([cx, n]) => (
          <g key={cx}>
            {Array.from({ length: n }, (_, i) => {
              const y = 148 - i * 8;
              return (
                <g key={i}>
                  <ellipse cx={cx} cy={y + 7} rx="30" ry="9" fill={d} />
                  <rect x={cx - 30} y={y} width="60" height="7" fill="#d9803a" />
                  <ellipse cx={cx} cy={y} rx="30" ry="9" fill={a} stroke="#ffe2c2" strokeWidth="1.2" />
                  <ellipse cx={cx} cy={y} rx="18" ry="5" fill="none" stroke={o} strokeWidth="1" />
                </g>
              );
            })}
          </g>
        ))}
        <path d="M160 30 C 150 48, 136 58, 140 76 C 142 88, 151 92, 160 92 C 169 92, 178 88, 180 76 C 182 62, 170 56, 168 44 C 165 50, 163 42, 160 30Z" fill="url(#pa-flame)" />
        <path d="M160 58 C 154 68, 150 74, 154 82 C 156 87, 160 88, 160 88 C 160 88, 164 87, 166 82 C 169 74, 163 68, 160 58Z" fill={c} opacity="0.9" />
        <Sparkle x={236} y={78} r={9} fill={p} /><Sparkle x={96} y={96} r={6} fill={p} op={0.8} /><Sparkle x={284} y={46} r={5} fill={a} />
      </>,
      <linearGradient id="pa-flame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={p} /><stop offset="0.5" stopColor={a} /><stop offset="1" stopColor={o} /></linearGradient>,
    );
  }

  if (kind === "newspaper") {
    // Agent Report: a front page (masthead, headline, photo, columns) with a "quote checked" stamp
    return svg(
      <>
        <rect x="84" y="20" width="160" height="152" fill={d} />
        <rect x="76" y="12" width="160" height="152" fill={c} fillOpacity="0.93" stroke={a} strokeWidth="2.5" />
        <rect x="84" y="20" width="144" height="16" fill={o} />
        <rect x="108" y="26" width="96" height="4" fill={c} />
        <line x1="84" y1="41" x2="228" y2="41" stroke={d} strokeWidth="2" /><line x1="84" y1="44" x2="228" y2="44" stroke={d} strokeWidth="0.8" />
        <rect x="84" y="49" width="30" height="3" fill={m} /><rect x="196" y="49" width="32" height="3" fill={m} />
        <rect x="84" y="57" width="128" height="9" fill={d} /><rect x="84" y="70" width="88" height="6" fill={d} />
        <rect x="84" y="82" width="68" height="46" fill={a} />
        <circle cx="102" cy="95" r="6" fill={c} />
        <polygon points="84,128 108,100 120,112 132,98 152,128" fill={m} />
        <rect x="84" y="131" width="68" height="3" fill={m} />
        {[82, 88, 94, 100, 106, 112, 118, 124].map((y) => <line key={y} x1="158" x2="228" y1={y} y2={y} stroke={m} strokeWidth="2" />)}
        {[142, 148, 154].map((y) => <line key={`a${y}`} x1="84" x2="153" y1={y} y2={y} stroke={m} strokeWidth="2" />)}
        {[142, 148, 154].map((y) => <line key={`b${y}`} x1="160" x2="228" y1={y} y2={y} stroke={m} strokeWidth="2" />)}
        <line x1="156" y1="138" x2="156" y2="158" stroke={a} />
        <g transform="rotate(-7 224 140)">
          <rect x="196" y="116" width="52" height="48" fill={d} stroke={p} strokeWidth="2" />
          <rect x="201" y="121" width="42" height="38" fill="none" stroke={a} strokeWidth="1" />
          <polyline points="207,141 217,151 238,128" fill="none" stroke={o} strokeWidth="6" strokeLinecap="square" />
        </g>
      </>,
    );
  }

  if (kind === "scatter") {
    // Model Comparison: score against price, a stepped efficient frontier, a different marker per company
    const leaders = [[60, 128], [100, 104], [150, 70], [200, 46], [262, 28]];
    const others = [[78, 138], [88, 118], [118, 122], [130, 112], [170, 98], [176, 84], [214, 76], [230, 60], [240, 40], [284, 52]];
    const shapes = ["sq", "di", "tr", "sq", "di"];
    const mark = (s, x, y, r, fill, stroke) => (s === "di" ? <polygon points={`${x},${y - r * 1.35} ${x + r * 1.35},${y} ${x},${y + r * 1.35} ${x - r * 1.35},${y}`} fill={fill} stroke={stroke} strokeWidth="1.5" />
      : s === "tr" ? <polygon points={`${x},${y - r * 1.3} ${x + r * 1.25},${y + r} ${x - r * 1.25},${y + r}`} fill={fill} stroke={stroke} strokeWidth="1.5" />
        : <rect x={x - r} y={y - r} width={2 * r} height={2 * r} fill={fill} stroke={stroke} strokeWidth="1.5" />);
    return svg(
      <>
        {[36, 64, 92, 120].map((y) => <line key={y} x1="36" x2="306" y1={y} y2={y} stroke={grid} />)}
        {[66, 106, 146, 186, 226, 266].map((x) => <line key={x} x1={x} x2={x} y1="16" y2="150" stroke={grid} />)}
        <line x1="36" y1="150" x2="306" y2="150" stroke={ln} strokeWidth="1.5" /><line x1="36" y1="14" x2="36" y2="150" stroke={ln} strokeWidth="1.5" />
        {[66, 106, 146, 186, 226, 266].map((x) => <line key={`t${x}`} x1={x} x2={x} y1="150" y2="155" stroke={ln} />)}
        {[36, 64, 92, 120].map((y) => <line key={`y${y}`} x1="31" x2="36" y1={y} y2={y} stroke={ln} />)}
        <path d="M60 128H100V104H150V70H200V46H262V28" fill="none" stroke={p} strokeWidth="2" strokeDasharray="6 4" />
        {others.map(([x, y], k) => <g key={k}>{mark(["sq", "di", "tr"][k % 3], x, y, 4.5, d, a)}</g>)}
        {leaders.map(([x, y], k) => <g key={`l${k}`}>{mark(shapes[k], x, y, 6, k % 2 ? p : o, c)}</g>)}
        <rect x="248" y="14" width="28" height="28" fill="none" stroke={c} strokeDasharray="3 3" />
        <g transform="translate(46 22)">
          <rect x="0" y="-4" width="8" height="8" fill={o} /><line x1="12" x2="28" y1="0" y2="0" stroke={ln} strokeWidth="2" />
          <polygon points="44,-6 50,0 44,6 38,0" fill={p} /><line x1="54" x2="70" y1="0" y2="0" stroke={ln} strokeWidth="2" />
          <polygon points="86,-5 92,5 80,5" fill={a} /><line x1="96" x2="112" y1="0" y2="0" stroke={ln} strokeWidth="2" />
        </g>
      </>,
    );
  }

  if (kind === "mindmap") {
    // Mindmap Studio: a root with branches and leaves, one collapsed branch and one selected node
    const right = [[36, [18, 50]], [90, [90]], [144, [128, 160]]];
    const left = [[36, [20]], [90, [66, 112]], [144, [150]]];
    const node = (x, y, w, h, key, hot, extra) => (
      <g key={key}>
        <rect x={x} y={y - h / 2} width={w} height={h} fill={hot ? o : c} fillOpacity={hot ? 1 : 0.93} stroke={hot ? p : a} strokeWidth="2" />
        <rect x={x + 6} y={y - 2} width={w - 12 - (extra || 0)} height="3" fill={hot ? c : d} />
        {h > 16 && <rect x={x + 6} y={y + 4} width={(w - 12) * 0.55} height="2" fill={hot ? p : m} />}
      </g>
    );
    return svg(
      <>
        {right.map(([y, leaves]) => (
          <g key={`r${y}`} fill="none" stroke={a} strokeWidth="2">
            <path d={`M188 90 C 201 90, 201 ${y}, 214 ${y}`} />
            {leaves.map((ly) => <path key={ly} d={`M268 ${y} C 276 ${y}, 276 ${ly}, 284 ${ly}`} strokeWidth="1.5" />)}
          </g>
        ))}
        {left.map(([y, leaves]) => (
          <g key={`l${y}`} fill="none" stroke={a} strokeWidth="2">
            <path d={`M132 90 C 119 90, 119 ${y}, 106 ${y}`} />
            {leaves.map((ly) => <path key={ly} d={`M56 ${y} C 48 ${y}, 48 ${ly}, 40 ${ly}`} strokeWidth="1.5" />)}
          </g>
        ))}
        {right.map(([y, leaves]) => <g key={`rn${y}`}>{node(214, y, 54, 22, `n${y}`, y === 36)}{leaves.map((ly) => node(284, ly, 30, 12, `lf${ly}`, false))}</g>)}
        {left.map(([y, leaves]) => <g key={`ln${y}`}>{node(52, y, 54, 22, `n${y}`, false)}{leaves.map((ly) => node(6, ly, 30, 12, `lf${ly}`, false))}</g>)}
        {node(132, 90, 56, 30, "root", true, 10)}
        <rect x="170" y="85" width="12" height="10" fill={c} /><rect x="172" y="88" width="8" height="1.5" fill={o} /><rect x="172" y="91" width="5" height="1.5" fill={o} />
        <rect x="260" y="84" width="10" height="10" fill={d} stroke={p} /><path d="M262 89H268M265 86V92" stroke={p} strokeWidth="1.5" />
        <rect x="262" y="30" width="10" height="10" fill={d} stroke={p} /><path d="M264 35H270" stroke={p} strokeWidth="1.5" />
      </>,
    );
  }

  if (kind === "paddles") {
    // Rally: a court with a pixel scoreboard, two paddles, a ball trailing afterimages, and the recorded-input timeline for the replay
    return svg(
      <>
        <rect x="10" y="12" width="300" height="156" fill="none" stroke={ln} strokeWidth="1.5" />
        <path d="M10 28V12H26M294 12H310V28M10 152V168H26M294 168H310V152" fill="none" stroke={a} strokeWidth="2" />
        <line x1="160" y1="18" x2="160" y2="140" stroke={ln} strokeWidth="1.5" strokeDasharray="5 6" />
        <PixelDigit ch="3" x={104} y={24} s={5} fill={a} op={0.55} /><PixelDigit ch="2" x={196} y={24} s={5} fill={a} op={0.55} />
        <rect x="30" y="72" width="8" height="44" fill={o} /><rect x="32" y="74" width="2" height="40" fill={p} opacity="0.7" />
        <rect x="282" y="44" width="8" height="44" fill={p} /><rect x="284" y="46" width="2" height="40" fill={c} opacity="0.7" />
        {[4, 3, 2, 1, 0].map((k) => (
          <rect key={k} x="-6" y="-6" width="12" height="12" fill={k ? a : c} opacity={k ? 0.55 - k * 0.1 : 1}
            transform={`translate(${218 - k * 24} ${64 + k * 9}) rotate(${22 - k * 14}) scale(${1 - k * 0.1})`} />
        ))}
        <path d="M44 96 l-9 -5 M44 100 l-12 0 M44 104 l-9 5" stroke={p} strokeWidth="2" fill="none" />
        <line x1="24" y1="152" x2="296" y2="152" stroke={ln} />
        {Array.from({ length: 34 }, (_, i) => <line key={i} x1={28 + i * 8} x2={28 + i * 8} y1="146" y2={i % 4 ? 152 : 158} stroke={i < 21 ? a : ln} />)}
        <rect x="190" y="143" width="8" height="18" fill={o} stroke={p} />
        <polygon points="44,148 56,154 44,160" fill={p} />
      </>,
    );
  }

  if (kind === "spark") {
    // Graphics: nebula glow, a big sparkle, a ringed planet, a signature scribble and a filmstrip of an animation
    return svg(
      <>
        <circle cx="106" cy="86" r="84" fill="url(#pa-neb1)" /><circle cx="238" cy="70" r="64" fill="url(#pa-neb2)" />
        {[[34, 26, 4], [60, 50, 3], [150, 22, 4], [186, 44, 3], [296, 24, 5], [284, 120, 3], [22, 96, 3], [140, 126, 3]].map(([x, y, r], i) => <Sparkle key={i} x={x} y={y} r={r} fill={i % 2 ? p : c} op={0.85} />)}
        <Sparkle x={96} y={66} r={38} fill={o} /><Sparkle x={96} y={66} r={20} fill={p} /><circle cx="96" cy="66" r="4" fill={c} />
        <path d="M182 98 A50 12 0 0 1 282 98" fill="none" stroke={p} strokeWidth="3" transform="rotate(-18 232 98)" />
        <circle cx="232" cy="98" r="27" fill="url(#pa-planet)" stroke={a} strokeWidth="1.5" />
        <path d="M208 90 Q232 100 256 88 M206 104 Q232 114 258 102" fill="none" stroke={d} strokeWidth="1.5" opacity="0.55" />
        <path d="M182 98 A50 12 0 0 0 282 98" fill="none" stroke={p} strokeWidth="3" transform="rotate(-18 232 98)" />
        <path d="M24 146 C 38 122, 52 156, 64 138 S 86 124, 94 146 S 116 156, 128 134 L 144 154 C 154 124, 166 156, 184 142" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M30 162 C 80 154, 130 168, 188 158" fill="none" stroke={a} strokeWidth="2" strokeLinecap="round" />
        <g transform="translate(198 134)">
          <rect x="0" y="0" width="108" height="34" fill={d} stroke={a} strokeWidth="1.5" />
          {[0, 1, 2, 3, 4, 5, 6].map((i) => <g key={i}><rect x={5 + i * 15} y="3" width="6" height="3" fill={a} /><rect x={5 + i * 15} y="28" width="6" height="3" fill={a} /></g>)}
          {[0, 1, 2].map((i) => (
            <g key={`f${i}`}>
              <rect x={6 + i * 34} y="9" width="30" height="16" fill="#1c0e08" stroke={ln} />
              <Sparkle x={21 + i * 34} y={17} r={3 + i * 2.2} fill={i === 2 ? o : p} />
            </g>
          ))}
        </g>
      </>,
      <>
        <radialGradient id="pa-neb1"><stop offset="0" stopColor={o} stopOpacity="0.38" /><stop offset="1" stopColor={o} stopOpacity="0" /></radialGradient>
        <radialGradient id="pa-neb2"><stop offset="0" stopColor={p} stopOpacity="0.26" /><stop offset="1" stopColor={p} stopOpacity="0" /></radialGradient>
        <radialGradient id="pa-planet" cx="34%" cy="30%" r="85%"><stop offset="0" stopColor="#ffe2c2" /><stop offset="0.55" stopColor={a} /><stop offset="1" stopColor={d} /></radialGradient>
      </>,
    );
  }

  // whiteboard: Scratch, a board on an easel with a flowchart, a plot, sticky notes and code
  return svg(
    <>
      <line x1="112" y1="130" x2="96" y2="172" stroke={d} strokeWidth="4" strokeLinecap="square" /><line x1="208" y1="130" x2="224" y2="172" stroke={d} strokeWidth="4" strokeLinecap="square" />
      <line x1="160" y1="130" x2="160" y2="172" stroke={d} strokeWidth="4" strokeLinecap="square" />
      <rect x="40" y="10" width="240" height="120" fill={c} fillOpacity="0.93" stroke={a} strokeWidth="3" />
      <rect x="47" y="17" width="226" height="106" fill="none" stroke={ln} strokeWidth="1" />
      <rect x="56" y="26" width="46" height="24" fill="none" stroke={o} strokeWidth="2.5" />
      <path d="M102 38H124M118 33L124 38L118 43" fill="none" stroke={o} strokeWidth="2.5" />
      <polygon points="150,26 176,38 150,50 124,38" fill="none" stroke={m} strokeWidth="2.5" />
      <path d="M176 38H198M192 33L198 38L192 43" fill="none" stroke={o} strokeWidth="2.5" />
      <rect x="198" y="26" width="46" height="24" fill="none" stroke={o} strokeWidth="2.5" />
      <path d="M150 50V64" stroke={m} strokeWidth="2" strokeDasharray="3 3" />
      <g transform="rotate(-5 76 90)"><rect x="58" y="70" width="38" height="34" fill={p} />{[78, 85, 92].map((y) => <line key={y} x1="64" x2="90" y1={y} y2={y} stroke={d} strokeWidth="2" />)}</g>
      <g transform="rotate(4 118 92)"><rect x="104" y="72" width="34" height="32" fill={a} />{[80, 87, 94].map((y) => <line key={y} x1="110" x2="132" y1={y} y2={y} stroke={d} strokeWidth="2" />)}</g>
      <path d="M166 100 C 176 76, 186 76, 194 92 S 208 108, 220 82 S 232 72, 240 80" fill="none" stroke={o} strokeWidth="3" strokeLinecap="round" />
      <path d="M164 70V108H246" fill="none" stroke={m} strokeWidth="1.5" />
      <path d="M252 64q-7 0 -7 7v6q0 4 -4 4q4 0 4 4v6q0 7 7 7M264 64q7 0 7 7v6q0 4 4 4q-4 0 -4 4v6q0 7 -7 7" fill="none" stroke={m} strokeWidth="2" transform="translate(-3 4) scale(0.8)" />
      <rect x="92" y="130" width="136" height="7" fill={a} />
      <rect x="170" y="123" width="30" height="7" fill={o} /><rect x="200" y="124" width="6" height="5" fill={d} />
      <rect x="116" y="123" width="22" height="7" fill={d} stroke={m} />
    </>,
  );
}

function ProjectsPortal() {
  return (
    <div className="content">
      <div className="projects-intro">
        <h1 className="page-title">Projects</h1>
      </div>
      <div className="project-grid">
        {projects.map((p) => (
          <a key={p.key} href={p.href} className="project-card panel">
            <div className="project-art-wrap"><ProjectArt kind={p.art} /></div>
            <div className="project-card-body">
              <h2 className="project-title">{p.title}</h2>
              {/* the whole card is the link, so the button is a span; it wears the home page's ruled-button look */}
              <span className="project-open rule-link">{p.cta || (p.external ? "Open explorer" : "Open")}<RuleFeet /></span>
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

// Alchemy moved to its own page (/projects/alchemy/, like the tennis explorer); keep old
// #/projects/alchemy links and bookmarks working.
function MovedTo({ href }) {
  useEffect(() => { window.location.replace(href); }, [href]);
  return <div className="content"><p className="prose">Moved to <a href={href}>{href}</a>…</p></div>;
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

function ScratchPage({ file }) {
  const current = scratchFiles.find((f) => f.name === file);
  const [doc, setDoc] = useState({ name: null, html: "" });
  useEffect(() => {
    if (!current || current.live) return undefined;
    let live = true;
    fetch(`${import.meta.env.BASE_URL}${current.src}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
      .then((md) => live && setDoc({ name: current.name, html: marked.parse(md) }))
      .catch(() => live && setDoc({ name: current.name, html: "<p>Could not load this file.</p>" }));
    return () => { live = false; };
  }, [current]);
  return (
    <ProjectPage>
      <Section id="scratch" title="Scratch">
        <div className="panel panel-body">
          <div className="scratch-files" role="list" aria-label="Scratch files">
            {scratchFiles.map((f) => (
              <a key={f.name} role="listitem" href={`#/projects/scratch/${f.name}`} className={`scratch-file${f.name === file ? " on" : ""}`}>
                <Icon name="file" size={16} />{f.name}
              </a>
            ))}
          </div>
          {current?.live ? <GatewayView /> : current ? (
            doc.name === current.name
              ? <article className="scratch-doc prose" dangerouslySetInnerHTML={{ __html: doc.html }} />
              : <p className="prose">Loading…</p>
          ) : <p className="prose scratch-hint">Pick a file to open it.</p>}
        </div>
      </Section>
    </ProjectPage>
  );
}

// Minimal hash router: only "#/projects..." paths are routes, so Home's own "#section"
// scroll anchors keep working untouched. No server rewrite needed on GitHub Pages.
const routeOf = (hash) => {
  const m = /^#\/projects(?:\/(alchemy|graphics|scratch(?:\/[\w-]+)?))?\/?$/.exec(hash || "");
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
    if (route === "home" && hashSection()) return; // opened at "#section": useHashLanding places it
    window.scrollTo(0, 0); // a fresh page starts at the top
  }, [route]);
  return route;
}

// Opening the site at "#section" (a shared link, a reload, or coming back from a project page):
// the browser looks for the anchor before React has drawn it, and the page above it is still
// settling (the top bar grows as the font arrives, sections rise in, images load), so its own jump
// lands in the wrong place or not at all. So Home places the section itself and keeps it there
// until the layout stops moving or the visitor scrolls, clicks or types.
const hashSection = () => {
  const id = typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.slice(1));
  const el = id && !id.includes("/") ? document.getElementById(id) : null;
  return el?.classList.contains("site-section") ? el : null;
};
function useHashLanding() {
  useEffect(() => {
    const el = hashSection();
    if (!el) return undefined;
    const gap = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    const start = performance.now();
    let frame = 0;
    let settledAt = 0;
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"];
    const stop = () => {
      cancelAnimationFrame(frame);
      inputs.forEach((type) => window.removeEventListener(type, stop));
    };
    const pin = (now) => {
      // layout position, not the drawn one: the section is mid rise-in and should rise into place
      let top = -gap;
      for (let node = el; node; node = node.offsetParent) top += node.offsetTop;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const want = Math.max(0, Math.min(max, top));
      if (Math.abs(want - window.scrollY) > 1) {
        window.scrollTo({ top: want, behavior: "instant" });
        settledAt = 0;
      } else if (!settledAt) settledAt = now;
      // done once it has held still for a second after the page finished loading; 10 s at most
      const loaded = document.readyState === "complete";
      if ((loaded && settledAt && now - settledAt > 1000) || now - start > 10000) { stop(); return; }
      frame = requestAnimationFrame(pin);
    };
    inputs.forEach((type) => window.addEventListener(type, stop, { passive: true }));
    frame = requestAnimationFrame(pin);
    return stop;
  }, []);
}

// Lite mode: ?lite / ?full in the address set it (and remember it); otherwise the saved choice. With
// none saved, lite is the default, and only a device that looks fast gets the full version
// (window.__fastDevice, worked out by the script in index.html before the app loads).
const LITE_KEY = "site-lite";
function initialLite() {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search);
  const forced = q.has("full") || q.get("lite") === "0" ? false : q.has("lite") ? true : null;
  try {
    if (forced !== null) { localStorage.setItem(LITE_KEY, forced ? "1" : "0"); return forced; }
    const saved = localStorage.getItem(LITE_KEY);
    if (saved !== null) return saved === "1";
  } catch { /* storage blocked: fall through */ }
  return forced ?? window.__fastDevice !== true;
}
function useLiteMode() {
  const [lite, setLite] = useState(initialLite);
  const toggle = () => setLite((v) => {
    try { localStorage.setItem(LITE_KEY, v ? "0" : "1"); } catch { /* this visit only */ }
    return !v;
  });
  return [lite, toggle];
}

// Projects dropdown: a search box over the projects list, sorted A–Z. The list box is sized to show
// three rows, so the first three alphabetically are what you see on open; scroll or type for the rest.
const projectsAZ = [...projects].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
const projectHaystack = (p) => [p.title, p.key === "atp" ? "Tennis" : "", ...p.tags].join(" ").toLowerCase();

function ProjectsMenu({ route }) {
  // like the phone menu, it remembers the page it was opened on, so changing page closes it
  const [openRoute, setOpenRoute] = useState(null);
  const open = openRoute === route;
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const q = query.trim().toLowerCase();
  const matches = q ? projectsAZ.filter((p) => q.split(/\s+/).every((w) => projectHaystack(p).includes(w))) : projectsAZ;
  const isCurrent = (p) => route === `projects/${p.key}` || route.startsWith(`projects/${p.key}/`);

  const close = () => { setOpenRoute(null); setQuery(""); setHi(0); };
  const toggle = () => { if (open) close(); else { setOpenRoute(route); setHi(0); } };

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus({ preventScroll: true });
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) close(); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => { // keep the highlighted row in view while arrowing through the list
    listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); wrapRef.current?.querySelector(".projects-trigger")?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && matches[hi]) { e.preventDefault(); window.location.assign(matches[hi].href); close(); }
  };

  return (
    <div className="projects-menu" ref={wrapRef} onKeyDown={onKeyDown}>
      <button type="button" className={`nav-link projects-trigger${route.startsWith("projects") ? " active" : ""}${open ? " open" : ""}`}
        aria-expanded={open} aria-haspopup="true" aria-controls="projects-panel" onClick={toggle}>
        Projects<span className="caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="projects-panel" id="projects-panel">
          <input ref={inputRef} type="search" className="projects-search" placeholder="Search projects…" value={query}
            aria-label="Search projects" aria-controls="projects-list" aria-activedescendant={matches[hi] ? `pm-${matches[hi].key}` : undefined}
            onChange={(e) => { setQuery(e.target.value); setHi(0); }} />
          {matches.length ? (
            <ul className="projects-list" id="projects-list" role="listbox" aria-label="Projects" ref={listRef}>
              {matches.map((p, i) => (
                <li key={p.key} id={`pm-${p.key}`} role="option" aria-selected={i === hi}>
                  <a href={p.href} className={`projects-item${i === hi ? " hi" : ""}${isCurrent(p) ? " current" : ""}`}
                    onMouseEnter={() => setHi(i)} onClick={close}>
                    <span className="projects-item-title">{p.title}</span>
                    <span className="projects-item-tags">{p.tags.join(" · ")}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="projects-empty">No projects match “{query.trim()}”.</p>
          )}
          <div className="projects-foot">
            <span>{matches.length} of {projects.length}</span>
            <a href="#/projects" onClick={close}>All projects →</a>
          </div>
        </div>
      )}
    </div>
  );
}

function Topbar({ route, lite, onToggleLite }) {
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
          <img src={assets.pfpSmall} alt="Preet Patel profile" className="brand-mark" width="162" height="243" decoding="async" />
          <div>
            <div className="brand-title">Preet Patel</div>
            <div className="brand-subtitle">Physics • Astronomy • Data Science</div>
          </div>
        </a>
        {/* narrow screens: in the bar, between the name and the menu button (the wide copy is in the navigation below) */}
        <button type="button" className={`nav-link lite-toggle lite-toggle-bar${lite ? " on" : ""}`} aria-pressed={lite} onClick={onToggleLite}
          title="Lite mode: a still background with no animation, blur or tilt. Easier on older laptops and phones.">
          <span className="lite-box" aria-hidden="true" />Lite
        </button>
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
            <a href="#/" className="nav-link">Home</a>
          ) : (
            sections.map((section) => <NavLink key={section.id} section={section} />)
          )}
          <ProjectsMenu route={route} />
          {/* wide screens: last in the navigation, the top-right corner (hidden at the menu breakpoint) */}
          <button type="button" className={`nav-link lite-toggle lite-toggle-nav${lite ? " on" : ""}`} aria-pressed={lite} onClick={onToggleLite}
            title="Lite mode: a still background with no animation, blur or tilt. Easier on older laptops and phones.">
            <span className="lite-box" aria-hidden="true" />Lite
          </button>
        </nav>
      </div>
    </header>
  );
}

export default function PreetPatelSite() {
  const route = useHashRoute();
  const [lite, toggleLite] = useLiteMode();
  return (
    <main className={`site-root${lite ? " lite" : ""}`}>
      <Css />
      <div className="bg-scroll-layer" />
      <Topbar route={route} lite={lite} onToggleLite={toggleLite} />
      {route === "projects" ? <ProjectsPortal /> : route === "projects/alchemy" ? <MovedTo href="/projects/alchemy/" /> : route === "projects/graphics" ? <GraphicsPage /> : route.startsWith("projects/scratch") ? <ScratchPage file={route.split("/")[2]} /> : <HomePage lite={lite} />}
      <footer className="footer">© Preet Patel. Graphics: Preet Patel. Layout recreated in React. Built (nearly) in full with Agentic Coding.</footer>
    </main>
  );
}
