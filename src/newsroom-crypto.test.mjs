import test from "node:test";
import assert from "node:assert/strict";
import { deriveBits, deriveSession, encryptDoc, decryptDoc, toB64, sha256Hex } from "./newsroom-crypto.js";

const salt = toB64(new Uint8Array(16).fill(7));
const iter = 1000; // fast for tests; the protocol value is 310000

test("64 bytes split into 32-byte key and 64-hex token", async () => {
  const bits = await deriveBits("pw", salt, iter);
  assert.equal(bits.length, 64);
  const s = await deriveSession("pw", salt, iter);
  assert.match(s.token, /^[0-9a-f]{64}$/);
  assert.equal(s.token, Buffer.from(bits.slice(32)).toString("hex"));
  assert.equal(s.key.extractable, false);
  assert.equal((await sha256Hex("abc")).length, 64);
});

test("round trip with AAD binding", async () => {
  const { key } = await deriveSession("pw", salt, iter);
  const name = "out/r-abc12345/status.json";
  const env = await encryptDoc(key, name, 42, { hello: "wörld" });
  assert.equal(env.v, 1);
  assert.deepEqual(await decryptDoc(key, env, name), { hello: "wörld" });
});

test("wrong name, seq, or key fails", async () => {
  const { key } = await deriveSession("pw", salt, iter);
  const other = await deriveSession("pw2", salt, iter);
  const name = "out/r-abc12345/status.json";
  const env = await encryptDoc(key, name, 42, { a: 1 });
  await assert.rejects(decryptDoc(key, env, "out/r-abc12345/plane.json"));
  await assert.rejects(decryptDoc(key, { ...env, name: "out/r-abc12345/plane.json" }, "out/r-abc12345/plane.json"));
  await assert.rejects(decryptDoc(key, { ...env, seq: 43 }, name));
  await assert.rejects(decryptDoc(other.key, env, name));
});
