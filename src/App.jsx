import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import AlchemyDashboard from "./Alchemy.jsx";

const base = "https://patelpb96.github.io";

const assets = {
  logoTop: `${base}/logo_top.png`,
  logoBot: `${base}/logo_bot.png`,
  core: `${base}/core.png`,
  bg: `${base}/bg.jpg`,
  bgGif: `${base}/assets/bg.gif`,
  introImg: `${base}/images/pic01.png`,
  pfp: `${base}/pfp.jpg`,
  galaxies: `${base}/images/8gals_GIF.gif`,
  graphics: [
    `${base}/images/A1.webp`,
    `${base}/images/A85.webp`,
    `${base}/images/Joey.gif`,
    `${base}/images/Kylo.gif`,
    `${base}/images/Pkh.gif`,
  ],
};

// Home lives on one scrolling page; Graphics + Alchemy live on the /projects page.
const sections = ["Intro", "Research", "Resume", "Contact"];
const projectSections = ["Alchemy", "Graphics"];

const contactCards = [
  { label: "Email", value: "patelpb96@gmail.com", href: "mailto:patelpb96@gmail.com", icon: "mail" },
  { label: "Phone", value: "2² × 199 × 7923563", href: null, icon: "phone" },
  { label: "GitHub", value: "patelpb96", href: "https://github.com/patelpb96", icon: "github" },
  { label: "LinkedIn", value: "patelpb96", href: "https://www.linkedin.com/in/patelpb96/", icon: "linkedin" },
];

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

const starFields = {
  farBack: makeStarField(280, 137, { centerBias: 0.18, minSize: 0.25, maxSize: 0.7, alpha: 0.30 }),
  midBack: makeStarField(220, 71, { centerBias: 0.20, minSize: 0.3, maxSize: 0.8, alpha: 0.42 }),
  mid: makeStarField(180, 91, { centerBias: 0.22, minSize: 0.35, maxSize: 0.9, alpha: 0.52 }),
  back: makeStarField(150, 23, { centerBias: 0.24, minSize: 0.4, maxSize: 1.0, alpha: 0.62 }),
  front: makeStarField(14, 211, { centerBias: 0.12, minSize: 1.1, maxSize: 2.2, alpha: 1.0, glow: true }),
  ultraFront: makeStarField(4, 911, { centerBias: 0.08, minSize: 2.2, maxSize: 4.0, alpha: 1.0, glow: true, fullOpacity: true }),
};

function LazyGraphic({ src, alt }) {
  const [loaded, setLoaded] = useState(false);

  if (!loaded) {
    return (
      <button className="lazy-graphic" type="button" onClick={() => setLoaded(true)} aria-label={`Load ${alt}`}>
        <span>Click to load image</span>
        <small>50+ MB</small>
      </button>
    );
  }

  return <img src={src} alt={alt} loading="lazy" />;
}

function assertSiteData() {
  if (typeof console === "undefined" || typeof console.assert !== "function") return;
  console.assert(Array.isArray(sections), "sections should be an array");
  console.assert(sections.length === 4, "expected four home navigation sections");
  console.assert(projectSections.length === 2, "expected Graphics and Alchemy on the projects page");
  console.assert(base.startsWith("https://"), "base URL should be absolute HTTPS");
  console.assert(assets.bg.endsWith("/bg.jpg"), "background image should use the hosted bg image");
  console.assert(assets.pfp === `${base}/pfp.jpg`, "hero image should use pfp.jpg");
  console.assert(assets.introImg === `${base}/images/pic01.png`, "intro image should use images/pic01.png");
  console.assert(assets.graphics.length >= 5, "graphics section should include newer and older animations");
  console.assert(contactCards.some((card) => card.href?.startsWith("mailto:")), "contact cards should include a mailto link");
  console.assert(contactCards.every((card) => card.label && card.icon), "each contact card should have a label and icon key");
  console.assert(!contactCards.some((card) => card.label === "Twitter"), "Twitter should not be included");
  console.assert(`${base}/assets/Resume_public.pdf`.endsWith("assets/Resume_public.pdf"), "resume link should point to the hosted PDF");
  console.assert(!starFields.back.includes('join("'), "back star field should be a finalized CSS string");
  console.assert(starFields.farBack.includes("radial-gradient"), "far-back star field should contain gradients");
  console.assert(starFields.midBack.includes("radial-gradient"), "mid-back star field should contain gradients");
  console.assert(starFields.mid.includes("radial-gradient"), "mid star field should contain gradients");
  console.assert(starFields.back.includes("radial-gradient"), "back star field should contain gradients");
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

function ContactCard({ card }) {
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
        mix-blend-mode: screen;
        background-image:
          ${starFields.farBack},
          ${starFields.midBack},
          ${starFields.mid},
          ${starFields.back};
        background-size: 100% 100%;
        background-position: center;
        filter: drop-shadow(0 0 3px rgba(255,210,170,0.35));
        animation: pageStarTwinkle 1.6s linear infinite;
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
      }

      @keyframes rotate1 { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes rotate2 { from { transform: rotate(0deg); } to { transform: rotate(720deg); } }
      @keyframes rotate3 { from { transform: rotate(0deg); } to { transform: rotate(1440deg); } }
      @keyframes orbitFrameA {
        0% { transform: rotate(-7deg) scaleX(1.0) scaleY(1.0); }
        20% { transform: rotate(6deg) scaleX(1.08) scaleY(0.86); }
        40% { transform: rotate(16deg) scaleX(0.95) scaleY(1.14); }
        60% { transform: rotate(10deg) scaleX(1.10) scaleY(0.84); }
        80% { transform: rotate(-2deg) scaleX(0.94) scaleY(1.16); }
        100% { transform: rotate(-7deg) scaleX(1.0) scaleY(1.0); }
      }
      @keyframes galaxyPulse {
        0%, 100% { filter: brightness(1.00) drop-shadow(0 0 10px rgba(255,170,100,0.36)); }
        50% { filter: brightness(1.08) drop-shadow(0 0 14px rgba(255,170,100,0.48)); }
      }
      @keyframes starTwinkleA {
        0%, 100% { filter: brightness(0.9); }
        50% { filter: brightness(1.25); }
      }
      @keyframes pageStarTwinkle {
        0% { opacity: 0.70; filter: brightness(0.92) drop-shadow(0 0 2px rgba(255,210,170,0.25)); }
        10% { opacity: 0.74; filter: brightness(1.02) drop-shadow(0 0 3px rgba(255,210,170,0.28)); }
        20% { opacity: 0.68; filter: brightness(0.95) drop-shadow(0 0 2px rgba(255,210,170,0.26)); }
        30% { opacity: 0.76; filter: brightness(1.05) drop-shadow(0 0 3px rgba(255,210,170,0.30)); }
        40% { opacity: 0.72; filter: brightness(0.98) drop-shadow(0 0 2px rgba(255,210,170,0.27)); }
        50% { opacity: 0.78; filter: brightness(1.06) drop-shadow(0 0 3px rgba(255,210,170,0.31)); }
        60% { opacity: 0.70; filter: brightness(0.96) drop-shadow(0 0 2px rgba(255,210,170,0.27)); }
        70% { opacity: 0.75; filter: brightness(1.04) drop-shadow(0 0 3px rgba(255,210,170,0.30)); }
        80% { opacity: 0.71; filter: brightness(0.97) drop-shadow(0 0 2px rgba(255,210,170,0.27)); }
        90% { opacity: 0.77; filter: brightness(1.05) drop-shadow(0 0 3px rgba(255,210,170,0.31)); }
        100% { opacity: 0.70; filter: brightness(0.92) drop-shadow(0 0 2px rgba(255,210,170,0.25)); }
      }
      @keyframes pageStarTwinkleBright {
        0% { opacity: 0.45; filter: brightness(0.95) drop-shadow(0 0 6px rgba(255,235,215,0.45)); }
        15% { opacity: 0.52; filter: brightness(1.10) drop-shadow(0 0 7px rgba(255,235,215,0.55)); }
        30% { opacity: 0.48; filter: brightness(1.02) drop-shadow(0 0 6px rgba(255,235,215,0.50)); }
        45% { opacity: 0.56; filter: brightness(1.18) drop-shadow(0 0 8px rgba(255,235,215,0.65)); }
        60% { opacity: 0.50; filter: brightness(1.05) drop-shadow(0 0 7px rgba(255,235,215,0.55)); }
        75% { opacity: 0.54; filter: brightness(1.15) drop-shadow(0 0 8px rgba(255,235,215,0.62)); }
        90% { opacity: 0.49; filter: brightness(1.03) drop-shadow(0 0 6px rgba(255,235,215,0.50)); }
        100% { opacity: 0.45; filter: brightness(0.95) drop-shadow(0 0 6px rgba(255,235,215,0.45)); }
      }
      @keyframes starTwinkleBgStrong {
        0%, 100% { filter: brightness(0.8) blur(0px); }
        50% { filter: brightness(1.4) blur(0.2px); }
      }
      @keyframes starTwinkleB {
        0%, 100% { filter: brightness(0.9); }
        50% { filter: brightness(1.3); }
      }
      @keyframes starTwinkleC {
        0%, 100% { filter: brightness(1.0); }
        50% { filter: brightness(1.35); }
      }
      @keyframes orbitCarrierA { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes orbitCarrierB { from { transform: rotate(180deg); } to { transform: rotate(540deg); } }
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
      }
      .starfield-farback {
        animation: starTwinkleBgStrong 5.8s ease-in-out infinite;
        z-index: 0;
        opacity: 0.7;
        transform: translate3d(calc(var(--star-x, 0px) * -18), calc(var(--star-y, 0px) * -18), 0) scale(1.05);
        background-image: ${starFields.farBack};
        background-size: 100% 100%;
        background-position: center;
      }
      .starfield-midback {
        animation: starTwinkleBgStrong 5.2s ease-in-out infinite;
        z-index: 1;
        opacity: 0.8;
        transform: translate3d(calc(var(--star-x, 0px) * -26), calc(var(--star-y, 0px) * -26), 0) scale(1.07);
        background-image: ${starFields.midBack};
        background-size: 100% 100%;
        background-position: center;
      }
      .starfield-mid {
        animation: starTwinkleBgStrong 4.6s ease-in-out infinite;
        z-index: 2;
        opacity: 0.88;
        transform: translate3d(calc(var(--star-x, 0px) * -34), calc(var(--star-y, 0px) * -34), 0) scale(1.09);
        background-image: ${starFields.mid};
        background-size: 100% 100%;
        background-position: center;
      }
      .starfield-back {
        animation: starTwinkleBgStrong 5.0s ease-in-out infinite;
        z-index: 1;
        opacity: 0.95;
        transform: translate3d(calc(var(--star-x, 0px) * -42), calc(var(--star-y, 0px) * -42), 0) scale(1.10);
        background-image: ${starFields.back};
        background-size: 100% 100%;
        background-position: center;
      }
      .starfield-front {
        animation: starTwinkleC 3.8s ease-in-out infinite;
        z-index: 6;
        opacity: 0.92;
        mix-blend-mode: screen;
        transform: translate3d(calc(var(--star-x, 0px) * 74), calc(var(--star-y, 0px) * 74), 0) scale(1.16);
        filter: drop-shadow(0 0 3px rgba(255,255,255,0.75));
        background-image: ${starFields.front};
        background-size: 100% 100%;
        background-position: center;
      }
      .starfield-ultrafront {
        animation: starTwinkleB 2.9s ease-in-out infinite;
        z-index: 7;
        opacity: 1;
        mix-blend-mode: screen;
        transform: translate3d(calc(var(--star-x, 0px) * 140), calc(var(--star-y, 0px) * 140), 0) scale(1.22);
        filter: drop-shadow(0 0 18px rgba(255,255,255,1)) drop-shadow(0 0 8px rgba(255,255,255,0.95));
        background-image: ${starFields.ultraFront};
        background-size: 100% 100%;
        background-position: center;
      }
      .galaxy-bg,
      .galaxy-fg {
        position: absolute;
        inset: 0;
        opacity: 1;
        display: grid;
        place-items: center;
        pointer-events: none;
        transition: transform 320ms ease-out;
      }
      .galaxy-bg {
        z-index: 2;
        transform: translate3d(calc(var(--star-x, 0px) * 6), calc(var(--star-y, 0px) * 6 + 4px), 0) scale(1.01);
      }
      .galaxy-fg {
        z-index: 4;
        transform: translate3d(calc(var(--star-x, 0px) * 6), calc(var(--star-y, 0px) * 6 + 4px), 0) scale(1.01);
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

      .orbit-system {
        position: relative;
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        perspective: 900px;
        transform-origin: 50% 50%;
        will-change: transform;
        animation: orbitFrameA 18s ease-in-out infinite;
      }
      .orbiter {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 80px;
        height: 80px;
        transform-origin: center;
        will-change: transform, opacity, filter;
      }
      .orbiter-a { transform: rotate(0deg); animation: orbitCarrierA 10.5s linear infinite; }
      .orbiter-b { transform: rotate(180deg); animation: orbitCarrierB 10.5s linear infinite; }
      .orbit-dot {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        transform: translateX(220px) scaleY(0.72);
        transform-origin: center;
      }
      .orbiter-b .orbit-dot { transform: translateX(220px) scaleY(0.72) rotateZ(25deg); }
      .galaxy-bg .orbit-dot { opacity: 0.42; }
      .galaxy-fg .orbit-dot { opacity: 0.92; }
      .galaxy-bg .original-galaxy,
      .galaxy-fg .original-galaxy { animation: galaxyPulse 6.8s ease-in-out infinite; }
      .galaxy-fg .original-galaxy { filter: brightness(1.08) drop-shadow(0 0 14px rgba(255,170,100,0.48)); }
      .galaxy-bg .original-galaxy { filter: brightness(0.92) drop-shadow(0 0 8px rgba(255,170,100,0.25)); }
      .orbiter-b .original-galaxy { transform: scaleY(0.82); }
      .original-galaxy { position: relative; width: 100%; aspect-ratio: 1; display: grid; place-items: center; }
      .original-galaxy .image1,
      .original-galaxy .image2,
      .original-galaxy .image3 {
        position: absolute;
        left: 0;
        width: 100%;
        height: 100%;
        border-radius: 0;
      }
      .original-galaxy .image1 { position: relative; overflow: hidden; animation: rotate1 6s linear infinite; z-index: 1; }
      .original-galaxy .image2 { animation: rotate2 6s linear infinite; z-index: 2; }
      .original-galaxy .image3 { animation: rotate3 6s linear infinite; z-index: 3; }
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
      .intro-image-frame { width: 100%; margin: 0 auto; overflow: visible; border-bottom: 1px solid var(--line); background: rgba(30,14,8,0.72); }
      .profile-image { width: 100%; height: auto; display: block; object-fit: contain; object-position: center; filter: contrast(1.05) saturate(0.98); }
      .galaxy-gif { width: 100%; display: block; background: #160a06; }
      .button-link {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
      .resume-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }

      .contact-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .contact-card { color: var(--text); text-decoration: none; border: 1px solid var(--line); border-radius: 0; padding: 20px; background: rgba(255,210,160,0.04); transition: 180ms ease; }
      .contact-card:hover { transform: translateY(-2px); background: rgba(255,170,100,0.12); border-color: rgba(255,170,100,0.46); }
      .contact-icon { color: var(--cyan); display: block; margin-bottom: 12px; }
      .contact-label { display: block; font-weight: 800; }
      .contact-value { display: block; color: var(--muted); margin-top: 3px; }

      .graphics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: center; }
      .graphics-grid.old { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .graphic-tile { display: grid; place-items: center; min-height: 160px; border-radius: 0; border: 1px solid var(--line); background: radial-gradient(circle at 50% 40%, rgba(255,170,100,0.10), rgba(255,220,180,0.03)); overflow: hidden; }
      .graphic-tile img { max-width: 100%; height: auto; display: block; }
      .subheading { color: #fff2e6; font-size: 1.45rem; margin: 0 0 18px; }
      .divider { height: 1px; background: var(--line); margin: 34px 0; }
      .footer { position: relative; z-index: 1; border-top: 1px solid var(--line); color: var(--dim); text-align: center; padding: 28px 16px; font-size: 0.86rem; background: rgba(9,10,13,0.7); }

      @media (max-width: 860px) {
        .nav { display: none; }
        .hero { min-height: auto; padding-top: 54px; }
        .hero-cards {
          grid-template-columns: 1fr;
          height: auto;
        }
        .image-card,
        .content-card {
          min-height: 360px;
          height: 40px;
        }
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
        .nav { display: none; }
        .hero { min-height: auto; padding-top: 54px; }
        .hero-cards { grid-template-columns: 1fr; height: 400px; }
        .image-card, .content-card { min-height: 360px; }
        .hero::before { inset: 0 -16px; }
        .resume-card { align-items: flex-start; flex-direction: column; }
        .contact-grid, .graphics-grid, .graphics-grid.old { grid-template-columns: 1fr; }
        .brand-subtitle { display: none; }
        .orbiter { width: 56px; height: 56px; }
        .orbit-dot { transform: translateX(150px) scaleY(0.72); }
        .orbiter-b .orbit-dot { transform: translateX(150px) scaleY(0.72) rotateZ(25deg); }
        .hero-title { font-size: clamp(3rem, 16vw, 5rem); }
        .content-card { padding: 24px; }
      }
    `}</style>
  );
}

function HomePage() {
  const [starParallax, setStarParallax] = useState({ x: 0, y: 0 });

  const handleStarParallax = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    setStarParallax({ x, y });
  };

  const resetStarParallax = () => setStarParallax({ x: 0, y: 0 });

  const renderGalaxyOrbit = (prefix) => (
    <div className="orbit-system" aria-hidden="true">
      {["orbiter-a", "orbiter-b"].map((orbiter) => (
        <div className={`orbiter ${orbiter}`} key={`${prefix}-${orbiter}`}>
          <div className="orbit-dot">
            <div className="original-galaxy">
              <img className="image1" src={assets.logoTop} alt="" />
              <img className="image2" src={assets.logoBot} alt="" />
              <img className="image3" src={assets.core} alt="" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <section className="hero">
        <div className="hero-cards">
          <motion.div className="hero-card image-card" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8 }}>
            <img src={assets.pfp} alt="Preet Patel" className="hero-image" />
          </motion.div>

          <motion.div
            className="hero-card content-card"
            style={{
              "--star-x": `${starParallax.x}px`,
              "--star-y": `${starParallax.y}px`,
              "--tilt-x": `${starParallax.x * 8}deg`,
              "--tilt-y": `${starParallax.y * 8}deg`,
              "--plane-shadow-x": `${starParallax.x * 18}px`,
              "--plane-shadow-y": `${starParallax.y * 18}px`,
            }}
            onMouseMove={handleStarParallax}
            onMouseLeave={resetStarParallax}
            onTouchMove={(event) => handleStarParallax(event.touches[0])}
            onTouchEnd={resetStarParallax}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9 }}
          >
            <div className="starfield starfield-farback" />
            <div className="starfield starfield-midback" />
            <div className="starfield starfield-mid" />
            <div className="starfield starfield-back" />
            <div className="galaxy-bg">{renderGalaxyOrbit("back")}</div>

            <div className="content-foreground">
              <p className="eyebrow">M.Sc. in Physics & Astronomy</p>
              <h1 className="hero-title">Preet<br />Patel</h1>
              <p className="hero-subtitle">Data Scientist | Astrophysicist</p>

              <div className="hero-actions">
                <ButtonLink href="#contact">Contact</ButtonLink>
                <ButtonLink href="#research">Research</ButtonLink>
                <ButtonLink href={`${base}/assets/Resume_public.pdf`}>Resume</ButtonLink>
              </div>
            </div>

            <div className="galaxy-fg">{renderGalaxyOrbit("front")}</div>
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
          <div className="panel">
            <img src={assets.galaxies} alt="Animated simulated low-mass galaxies" className="galaxy-gif" />
            <div className="panel-body prose">
              <h3 className="subheading">Elemental Abundances of Simulated Low-Mass Galaxies</h3>
              <p>For research, I previously focused on the elemental abundances of stars in low-mass dwarf galaxies simulated using <a href="https://fire.northwestern.edu/" target="_blank" rel="noreferrer">FIRE-2</a>.</p>
              <p>In my most recent project, I identified elemental abundance trends, measured in [Mg/Fe] versus [Fe/H], of several galaxies. I found imprints of bursty star formation and satellite accretion in the present-day elemental abundance distributions.</p>
              <p>This work culminated in a first-author publication, accepted by <a href="https://academic.oup.com/mnras" target="_blank" rel="noreferrer">MNRAS</a> in March 2022. The paper can be found on <a href="https://academic.oup.com/mnras/article/512/4/5671/6554259" target="_blank" rel="noreferrer">here</a>.</p>
              <p>My final project involved the new age-tracer module in FIRE-2 and FIRE-3, which allows one to retroactively test multiple models in rates for core-collapse supernovae, type Ia supernovae, and stellar winds without needing to re-run a simulation with altered models.</p>
            </div>
          </div>
        </Section>

        <Section id="resume" title="Resume">
          <div className="panel panel-body resume-card">
            <div className="resume-actions prose">
              <p>Embedded resume preview.</p>
              <ButtonLink href={`${base}/assets/Resume_public.pdf`}>Open PDF</ButtonLink>
            </div>
            <div className="resume-frame-shell">
              <iframe
                className="resume-frame"
                src={`${base}/assets/Resume_public.pdf#view=FitH`}
                title="Preet Patel Resume"
                loading="lazy"
              />
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

function ProjectsPage() {
  return (
    <div className="content">
      <div className="projects-intro">
        <h1 className="page-title">Projects</h1>
        <p className="page-lead prose">
          Interactive things I have built — a live Grand Exchange data dashboard and some graphics — floating on the same star field.
        </p>
      </div>

      <Section id="alchemy" title="Alchemy">
        <div className="panel panel-body">
          <AlchemyDashboard />
        </div>
      </Section>

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
    </div>
  );
}

// Minimal hash router: only "#/projects" is a route, so Home's own "#section"
// scroll anchors keep working untouched. No server rewrite needed on GitHub Pages.
function useHashRoute() {
  const [route, setRoute] = useState(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#/projects") ? "projects" : "home"
  );
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.startsWith("#/projects") ? "projects" : "home");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0); // a fresh page starts at the top
  }, [route]);
  return route;
}

function scrollToId(id) {
  const el = typeof document !== "undefined" ? document.getElementById(id) : null;
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Topbar({ route }) {
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
        <nav className="nav" aria-label="Primary navigation">
          {route === "projects" ? (
            <>
              <a href="#/" className="nav-link">Home</a>
              {projectSections.map((section) => (
                <button key={section} type="button" className="nav-link" onClick={() => scrollToId(section.toLowerCase())}>
                  {section}
                </button>
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
      {route === "projects" ? <ProjectsPage /> : <HomePage />}
      <footer className="footer">© Preet Patel. Graphics: Preet Patel. Layout recreated in React.</footer>
    </main>
  );
}
