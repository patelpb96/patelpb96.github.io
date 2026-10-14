// Gateway (#/projects/scratch/gateway) end-to-end encryption, shared by the site viewer
// and the local editor (scripts/gateway/, which serves this file as-is). Plain ESM, WebCrypto only.
//
//   key  = PBKDF2-SHA256(password, salt, 310k) -> AES-GCM-256 (non-extractable)
//   ct   = AES-GCM(key, iv, utf8(markdown), aad = "v|kid|seq")
//
// The server and S3 only ever see {v, kid, seq, salt, iv, ct}.

export const VERSION = 1;
export const ITERATIONS = 310000;
export const MIN_BITS = 56;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const newSalt = () => toB64(randomBytes(16));
export const newKid = () => Array.from(randomBytes(8), (b) => b.toString(16).padStart(2, "0")).join("");
const aad = (v, kid, seq) => enc.encode(`${v}|${kid}|${seq}`);

export async function deriveKey(password, saltB64) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations: ITERATIONS },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(key, { kid, seq }, text) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(VERSION, kid, seq) }, key, enc.encode(text));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Throws (OperationError) on a wrong key or any tampering with v/kid/seq/iv/ct. */
export async function decrypt(key, { v, kid, seq, iv, ct }) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(iv), additionalData: aad(v, kid, seq) }, key, fromB64(ct));
  return dec.decode(pt);
}

// ------------------------------------------------------------ password strength
// A deliberately conservative estimate (bits), not a proof. Word-like passwords are scored
// per word (at most an EFF-long-list word, 12.9 bits); character passwords by pool size times
// an effective length that discounts repeats ("aaaa") and runs ("abcd", "4321").
const WORD_BITS = Math.log2(7776);

function effectiveLength(pw) {
  let n = 0;
  for (let i = 0; i < pw.length; i++) {
    const c = pw.charCodeAt(i), p = pw.charCodeAt(i - 1), pp = pw.charCodeAt(i - 2);
    if (i > 0 && c === p) continue; // repeat
    if (i > 1 && c - p === p - pp && Math.abs(c - p) === 1) continue; // run of 3+
    n++;
  }
  return n;
}

function poolSize(pw) {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  return pool;
}

export function estimateEntropy(pw) {
  if (!pw) return 0;
  const tokens = pw.split(/[\s\-_.,+]+/).filter(Boolean);
  // "Password123!"-style: one word, optionally capitalised, plus digits/symbols at the end.
  const m = /^([A-Za-z]+)(\d*)([^A-Za-z0-9]*)$/.exec(pw);
  if (m && tokens.length === 1) {
    return Math.min(WORD_BITS, m[1].length * 2) + 1 + m[2].length * Math.log2(10) + (m[3] ? 5 : 0);
  }
  if (tokens.length >= 3 && tokens.every((t) => /^[A-Za-z]+\d*$/.test(t))) {
    return tokens.reduce((bits, t) => bits + Math.min(WORD_BITS, effectiveLength(t.toLowerCase()) * Math.log2(26)), 0)
      + (/[A-Z]/.test(pw) ? 1 : 0) + (/\d/.test(pw) ? 3 : 0);
  }
  return effectiveLength(pw) * Math.log2(Math.max(poolSize(pw), 1));
}
