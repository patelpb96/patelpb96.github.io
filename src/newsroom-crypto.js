// Newsroom relay crypto (see projects/newsroom/PROTOCOL.md). Plain ESM, WebCrypto only, so the
// same file runs in the browser, in node --test and in the fixture generator.
//   bits = PBKDF2-SHA256(utf8(password), salt, iter) -> 64 bytes
//   enc = bits[0:32] (AES-GCM-256, non-extractable), token = hex(bits[32:64])
//   ct  = AES-GCM(enc, iv, utf8(json), aad = "1|" + name + "|" + seq)

export const VERSION = 1;
const te = new TextEncoder();
const td = new TextDecoder();

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
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const aad = (name, seq) => te.encode(`${VERSION}|${name}|${seq}`);

/** Derive 64 bytes. Returns the raw bits (Uint8Array) so tests can check the split. */
export async function deriveBits(password, saltB64, iter) {
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations: iter }, base, 512);
  return new Uint8Array(bits);
}

/** -> { key: CryptoKey (non-extractable AES-GCM), token: 64 hex chars } */
export async function deriveSession(password, saltB64, iter) {
  const bits = await deriveBits(password, saltB64, iter);
  const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, token: toHex(bits.slice(32, 64)) };
}

export async function encryptDoc(key, name, seq, doc) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(name, seq) }, key, te.encode(JSON.stringify(doc)));
  return { v: VERSION, name, seq, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Decrypt an envelope. `name` is the path the caller asked for, so a swapped object fails. */
export async function decryptDoc(key, envelope, name) {
  if (!envelope || envelope.v !== VERSION || envelope.name !== name) throw new Error("envelope mismatch");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(envelope.iv), additionalData: aad(name, envelope.seq) },
    key, fromB64(envelope.ct));
  return JSON.parse(td.decode(pt));
}

export async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(text))));
}

// Day password (PROTOCOL.md "Day password"): config.day = { salt, iter, expires (epoch s), iv, ct } where
// ct = AES-GCM(day enc key, iv, raw 32-byte master enc key, aad = "1|day|" + expires). The holder gets the
// master enc key (so it reads everything) but writes with the day token, which the server stops
// accepting at `expires`.
const dayAad = (expires) => te.encode(`${VERSION}|day|${expires}`);

/** -> session like deriveSession's (plus { day: expires }), or null if `password` isn't the day password
 *  or the day password has expired. */
export async function openDay(password, day, nowMs = Date.now()) {
  if (!day || !day.salt || !day.iter || !day.ct || !(nowMs < day.expires * 1000)) return null;
  const bits = await deriveBits(password, day.salt, day.iter);
  const dayKey = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["decrypt"]);
  let raw;
  try {
    raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(day.iv), additionalData: dayAad(day.expires) },
      dayKey, fromB64(day.ct));
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, token: toHex(bits.slice(32, 64)), day: day.expires };
}

/** Test/fixture helper: wrap a raw master enc key for a day password (home does this in Python). */
export async function makeDay(password, masterRaw, saltB64, iter, expires) {
  const bits = await deriveBits(password, saltB64, iter);
  const dayKey = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: dayAad(expires) }, dayKey, masterRaw);
  return { salt: saltB64, iter, expires, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}
