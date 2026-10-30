// Search page key derivation (infra/search_setup.py does the same in Python). Plain ESM, WebCrypto only.
//   token = hex(PBKDF2-SHA256(utf8(password), salt, iter) -> 32 bytes), sent as x-search-key;
//   the server stores only sha256(token).
const te = new TextEncoder();
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function deriveToken(password, saltB64, iter) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, 256);
  return toHex(new Uint8Array(bits));
}

// The Lambda OAC signs requests with SigV4, which needs the body's SHA-256 from the viewer.
export async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(text))));
}
