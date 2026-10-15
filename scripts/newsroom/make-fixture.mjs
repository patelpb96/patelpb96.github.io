// Writes an encrypted, entirely FAKE newsroom data set for previewing the phone page:
//   node scripts/newsroom/make-fixture.mjs
//   npm run dev  ->  http://localhost:5173/projects/newsroom/?base=/live/fixture/newsroom/
//   node scripts/newsroom/make-fixture.mjs --open   also an open-mode slot (no password) for 2 h
//
// Output goes to public/live/fixture/newsroom/. public/live/ is gitignored and deploy-aws.sh
// excludes live/* from every sync, so the fixture can never be committed or uploaded.
// All outlets are example.com-style placeholders; nothing here is real news.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveSession, encryptDoc, toB64 } from "../../src/newsroom-crypto.js";

export const PASSWORD = "fixture-only correct horse battery staple";
const ITER = 310000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../public/live/fixture/newsroom");
const RID = "r-fixture0001";
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const H = 3600e3, M = 60e3;

const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
const { key } = await deriveSession(PASSWORD, salt, ITER);

const OPEN = process.argv.includes("--open");
const openRaw = crypto.getRandomValues(new Uint8Array(32));
const openKey = await crypto.subtle.importKey("raw", openRaw, "AES-GCM", false, ["encrypt"]);
const openSlot = { expires: Math.floor(now / 1000) + 2 * 3600, limit: 10, key: toB64(openRaw),
  token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("") };

async function put(name, doc, enc = true, k = key) {
  const body = enc ? await encryptDoc(k, name, now, doc) : doc;
  const path = join(OUT, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body));
}

// ---------------------------------------------------------------- sources + facts
const outlets = [
  ["s1", "oakland-daily.example.com", "Oakland Daily (fake)", "report", 20 * H],
  ["s2", "bayarea-wire.example.com", "Bay Area Wire (fake)", "report", 30 * H],
  ["s3", "techweek.example.com", "Tech Week Organizers (fake)", "official", 48 * H],
  ["s4", "oakland-city.example.com", "City of Oakland (fake)", "official", 26 * H],
  ["s5", "founders-weekly.example.com", "Founders Weekly (fake)", "opinion", 10 * H],
  ["s6", "transit-notes.example.com", "Transit Notes (fake)", "report", 18 * H],
  ["s7", "eastbay-eats.example.com", "East Bay Eats (fake)", "report", 12 * H],
  ["s8", "venture-ledger.example.com", "Venture Ledger (fake)", "report", 22 * H],
];
const sources = outlets.map(([id, domain, outlet, kind, ago]) => ({
  id, url: `https://${domain}/2026/tech-week/${id}`, domain, title: `${outlet.replace(" (fake)", "")}: Tech Week item ${id}`,
  outlet, published: kind === "opinion" ? null : iso(ago), fetched: iso(40 * M), kind,
}));
const q = (source, quote) => ({ source, quote });
const facts = [
  ["f1", "major", "A Tech Week demo night is scheduled at a Jack London Square venue in Oakland.", [q("s1", "Doors open at 6 pm for the demo night at the waterfront venue."), q("s3", "Oakland demo night: Jack London Square, 6 pm.")]],
  ["f2", "major", "More than 40 startups are listed to present at the Oakland demo night.", [q("s1", "Organizers say 42 startups will present."), q("s2", "Some forty teams are on the lineup.")]],
  ["f3", "minor", "Tickets for the demo night are free with registration.", [q("s3", "Registration is free; walk-ins subject to capacity.")]],
  ["f4", "major", "The city is running extra late-evening BART service on two nights of the week.", [q("s4", "Extended service on Tuesday and Thursday nights.")  , q("s6", "Riders can expect added trains after 10 pm on two nights.")]],
  ["f5", "minor", "Street parking near the waterfront is limited during the event.", [q("s6", "Parking near the square is expected to be scarce.")]],
  ["f6", "major", "A panel on East Bay manufacturing startups is on the Oakland program.", [q("s3", "Panel: Making things in the East Bay."), q("s8", "The manufacturing panel returns this year.")]],
  ["f7", "minor", "One founder argued that Oakland deserves its own flagship Tech Week hub.", [q("s5", "Oakland should not be a satellite; it should be a hub.")]],
  ["f8", "major", "A hardware showcase will run alongside the demo night.", [q("s1", "A hardware row will sit beside the main stage."), q("s2", "Hardware teams get their own showcase tables.")]],
  ["f9", "minor", "Several local restaurants are offering pre-event menus for attendees.", [q("s7", "Three nearby restaurants announced event-night menus.")]],
  ["f10", "major", "The venue capacity for the demo night is about 600 people.", [q("s4", "Occupancy permit lists 600."), q("s3", "Capacity is capped at roughly 600.")]],
  ["f11", "minor", "A volunteer signup for the event is open until the day before.", [q("s3", "Volunteer signups close the evening before.")]],
  ["f12", "major", "Venture investors from San Francisco are expected to attend the Oakland events.", [q("s8", "Several SF funds plan to send partners across the bay."), q("s2", "Investors from San Francisco are on the guest list.")]],
  ["f13", "minor", "Ferry service between SF and Oakland is a suggested way to arrive.", [q("s6", "Organizers suggest the ferry as an alternative to BART.")]],
  ["f14", "minor", "A networking breakfast is scheduled for the morning after the demo night.", [q("s3", "Breakfast meetup at 8 am the next day.")]],
].map(([id, scope, statement, srcs]) => ({ id, scope, statement, sources: srcs }));

const S = (text, ...f) => ({ text, facts: f });
const P = (...sentences) => ({ sentences });
// A fake chart (SVG data URI) so the picture layout can be previewed; real editions carry small JPEGs.
const FAKE_CHART = "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%27640%27%20height%3D%27360%27%20viewBox%3D%270%200%20640%20360%27%3E%3Crect%20width%3D%27640%27%20height%3D%27360%27%20fill%3D%27%23f4efe4%27/%3E%3Cg%20fill%3D%27%232b5d8a%27%3E%3Crect%20x%3D%2760%27%20y%3D%27220%27%20width%3D%2770%27%20height%3D%27100%27/%3E%3Crect%20x%3D%27160%27%20y%3D%27180%27%20width%3D%2770%27%20height%3D%27140%27/%3E%3Crect%20x%3D%27260%27%20y%3D%27140%27%20width%3D%2770%27%20height%3D%27180%27/%3E%3Crect%20x%3D%27360%27%20y%3D%27100%27%20width%3D%2770%27%20height%3D%27220%27/%3E%3Crect%20x%3D%27460%27%20y%3D%2760%27%20width%3D%2770%27%20height%3D%27260%27/%3E%3C/g%3E%3Ctext%20x%3D%2760%27%20y%3D%2740%27%20font-family%3D%27Georgia%27%20font-size%3D%2722%27%20fill%3D%27%23222%27%3EStartups%20presenting%20%28FAKE%20chart%29%3C/text%3E%3C/svg%3E";
const headline = {
  image: { src: FAKE_CHART, w: 640, h: 360, kind: "chart", alt: "Bar chart of startups presenting", caption: "Presenters by year (fake data)", credit: "Oakland Daily (fake)", source: "s1" },
  id: "a0", headline: "Oakland Demo Night Draws 40-Plus Startups to the Waterfront", desk: "Business", significance: 5,
  dek: "A free, 600-person event at Jack London Square anchors the East Bay's share of SF Tech Week.",
  paragraphs: [
    P(S("A demo night at a Jack London Square venue is the centrepiece of Oakland's Tech Week schedule.", "f1"),
      S("More than 40 startups are listed to present.", "f2"),
      S("Registration is free.", "f3")),
    P(S("Capacity is capped at about 600, so organizers expect the room to fill.", "f10"),
      S("A hardware showcase will run alongside the main stage.", "f8")),
  ],
};
const articles = [
  { id: "a1", headline: "Extra Late-Night BART Trains Planned for Two Evenings", desk: "Transit", significance: 3,
    dek: "Riders heading back to San Francisco after the events get added service.",
    paragraphs: [P(S("The city is adding late-evening service on two nights of the week.", "f4"), S("Parking near the waterfront will be limited.", "f5")),
      P(S("Organizers also suggest the ferry as an alternative way to arrive.", "f13"))] },
  { id: "a2", headline: "Manufacturing Panel Puts East Bay Makers on the Program", desk: "Industry", significance: 3,
    dek: "Hardware is a theme of the Oakland leg this year.",
    paragraphs: [P(S("A panel on East Bay manufacturing startups is on the program.", "f6"), S("It sits next to the hardware showcase.", "f8"))] },
  { id: "a3", headline: "SF Investors Expected to Cross the Bay", desk: "Venture", significance: 3,
    dek: "Guest lists suggest more than a token presence from San Francisco funds.",
    paragraphs: [P(S("Venture investors from San Francisco are expected at the Oakland events.", "f12")),
      P(S("A networking breakfast the morning after the demo night is intended to extend those conversations.", "f14"))] },
  { id: "a4", headline: "Opinion Corner: Should Oakland Be a Hub, Not a Satellite?", desk: "Opinion", significance: 2,
    dek: "One founder makes the case for a flagship East Bay presence.",
    paragraphs: [P(S("One founder argued that Oakland deserves its own flagship Tech Week hub.", "f7"))] },
  { id: "a5", headline: "Neighborhood Restaurants Roll Out Event-Night Menus", desk: "Food", significance: 1,
    dek: "A small boost for waterfront eateries.",
    paragraphs: [P(S("Several local restaurants are offering pre-event menus for attendees.", "f9"), S("Volunteers can still sign up until the day before.", "f11"))] },
];
const edition = {
  rid: RID, request: "Find me news in Oakland about SF Tech Week", title: "Oakland at SF Tech Week (fixture)", created: iso(25 * M),
  window: { start: iso(24 * H + 25 * M), end: iso(25 * M) }, headline, articles, sources, facts,
  notes: ["Only 5 stories passed verification.", "FIXTURE DATA: every outlet and quote is made up."],
  stats: { agents: 12, minutes: 14, cost_usd: null, billing: "plan" },
};

// ---------------------------------------------------------------- mid-run plane (~12 agents)
const nodes = [];
for (let i = 1; i <= 5; i++) nodes.push({ id: `tool_${i}`, kind: "tool", label: `tool_${i}`, group: "tools", groupLabel: "tools" });
for (let d = 1; d <= 3; d++) for (let i = 0; i < 3; i++)
  nodes.push({ id: `doc_${d}_${i}`, kind: "doc", label: `doctype_${d}`, group: `doctype_${d}`, groupLabel: `doctype_${d}` });
const states = ["working", "working", "idle", "done", "working", "idle", "working", "done", "working", "idle", "working", "working"];
for (let i = 1; i <= 12; i++)
  nodes.push({ id: `agent_${i}`, kind: "agent", label: `agent_${i}`, group: "agents", groupLabel: "agents",
    role: `role_${(i % 3) + 1}`, tier: i === 1 ? 0 : i <= 4 ? 1 : 2, state: states[i - 1] });
const edges = [];
const E = (src, dst, kind, active, pulse = false) => edges.push({ src, dst, kind, count: 1 + ((src.length * 7 + dst.length) % 9), active, pulse });
for (let i = 2; i <= 4; i++) E(`agent_${i}`, "agent_1", "reports", false);
for (let i = 5; i <= 12; i++) E(`agent_${i}`, `agent_${2 + (i % 3)}`, "reports", false);
for (let i = 1; i <= 12; i++) {
  if (states[i - 1] === "working") {
    E(`agent_${i}`, `tool_${(i % 5) + 1}`, "call", true, i % 4 === 0);
    if (i % 2) E(`agent_${i}`, `doc_${(i % 3) + 1}_${i % 3}`, "call", true);
  }
}
E("agent_1", "agent_2", "message", false, true);
const plane = { nodes, edges, generatedAt: now };

const status = { rid: RID, state: "running", phase: "verifying", progress: 0.62, message: "Cross-checking 9 claims against sources.",
  updated: iso(5e3), started: iso(9 * M) };
const doneStatus = { ...status, state: "done", phase: "published", progress: 1, message: "Edition ready.", finished: iso(25 * M) };

// ---------------------------------------------------------------- write
await put("config.json", { v: 1, salt, iter: ITER, ...(OPEN ? { open: openSlot } : {}) }, false);
await put("beat.json", { v: 1, beat: now + 10 * 365 * 24 * H, busy: false, version: "fixture" }, false); // far future = always "online"
await put("inbox/index.json", { v: 1, seq: 2, ids: [RID, "r-fixture0002"] }, false);
await put("out/index.json", { editions: [
  { rid: "r-fixture0002", title: "Running now: BART service changes", request: "Summarise BART service changes this week", created: iso(9 * M), state: "running", stories: 0 },
  { rid: RID, title: edition.title, request: edition.request, created: edition.created, state: "done", stories: 6 },
] });
await put(`out/${RID}/status.json`, doneStatus);
await put(`out/${RID}/plane.json`, plane);
await put(`out/${RID}/edition.json`, edition);
await put("out/r-fixture0002/status.json", status);
await put("out/r-fixture0002/plane.json", plane);
if (OPEN) {
  await put("open/out/index.json", { editions: [
    { rid: RID, title: edition.title, request: edition.request, created: edition.created, state: "done", stories: 6 },
  ], open: { expires: openSlot.expires, limit: 10, used: 3 } }, true, openKey);
  await put(`open/out/${RID}/status.json`, doneStatus, true, openKey);
  await put(`open/out/${RID}/plane.json`, plane, true, openKey);
  await put(`open/out/${RID}/edition.json`, edition, true, openKey);
}

console.log(`Fixture written to ${OUT}`);
console.log(`Password: ${PASSWORD}`);
console.log("Preview:  npm run dev  ->  http://localhost:5173/projects/newsroom/?base=/live/fixture/newsroom/");
