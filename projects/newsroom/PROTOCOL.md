# Newsdesk relay protocol (v1)

Shared contract between the home daemon (`newsdesk`, Python, agent-dashboard repo) and the
phone page (`patelpb.com/projects/newsroom/`, site repo) via AWS (CloudFront + Lambda + S3),
modelled on the Scratch gateway. AWS only ever stores ciphertext (plus a few plain counters).

## Secrets
- One password, known only to Preet. Entered on the phone, and once at home in `newsdesk setup`
  (never stored at home; only the derived bits are).
- Public `config.json` holds `{ "v": 1, "salt": <b64 16 bytes>, "iter": 310000 }`.
- `bits = PBKDF2-HMAC-SHA256(utf8(password), salt, iter, 64 bytes)`
  - `enc  = bits[0:32]`  → AES-GCM-256 key
  - `token = hex(bits[32:64])` (64 lowercase hex chars) → header `x-newsroom-key` on writes
- SSM `/patelpb/newsroom/key-sha256` = hex SHA-256 of the ASCII token string. The edge function
  `patelpb-newsroom-auth` and the Lambda both check `sha256(x-newsroom-key) == that`.
- Setup refuses passwords estimated below 60 bits (offline guessing against public ciphertext
  is the main threat, so the password must be strong).

## Day password (optional, one at a time, 24 h)
- `newsdesk temp` (home) takes a new password (≥ 60 bits, never used before, not the master),
  picks a fresh `daySalt`, and derives `dayBits` the same way (PBKDF2, same `iter`).
- `config.json` gains `day: { salt, iter, expires: <epoch s>, iv, ct }` with
  `ct = AES-GCM(dayBits[0:32], iv, raw master enc key (32 bytes), aad = utf8("1|day|" + expires))`.
  So the day password reads everything; it writes with `dayToken = hex(dayBits[32:64])`.
- SSM `/patelpb/newsroom/temp-sha256` = `"<hex sha256(dayToken)>:<expires>"`. The Lambda and the
  edge check (`cloudfront_api.py auth` bakes it in) accept that token only while `now < expires`.
- The phone tries `config.day` first when unexpired, else the master password. A new `newsdesk temp`
  replaces the old one; nothing is valid after expiry until the next `newsdesk temp`.

## Envelope (every encrypted object)
```json
{ "v": 1, "name": "out/r-abc123de/edition.json", "seq": 7, "iv": "<b64 12 bytes>", "ct": "<b64>" }
```
- `ct = AES-GCM(enc, iv, utf8(JSON plaintext), aad = utf8("1|" + name + "|" + seq))`
  (ciphertext includes the 16-byte tag at the end, as WebCrypto and Python `AESGCM` both do).
- `name` binds the ciphertext to its object path, so objects can't be swapped.
- `seq`: writer's monotonically increasing integer (ms timestamp is fine).

## Objects — `s3://patelpb-com-site/live/newsroom/…`, public GET via `https://patelpb.com/live/newsroom/…`
Written only through the Lambda (except `config.json`, written by setup with the AWS CLI).
`Cache-Control: public, max-age=1`. Readers add `?t=<now>` to dodge stale edges.

| Name | Encrypted | Written by | Content |
|---|---|---|---|
| `config.json` | no | setup | `{v, salt, iter}` |
| `beat.json` | no | home, every 20 s | `{v, beat: <ms>, busy: bool, version: "<daemon version>"}` |
| `inbox/index.json` | no | Lambda (on inbox put) | `{v, seq, ids: ["r-…", …]}` newest last, max 50 |
| `inbox/<rid>.json` | yes | phone | `Request` |
| `out/index.json` | yes | home | `{editions: [EditionSummary, …]}` newest first |
| `out/<rid>/status.json` | yes | home | `Status` |
| `out/<rid>/plane.json` | yes | home | `Plane` (stripped) |
| `out/<rid>/edition.json` | yes | home | `Edition` |

`rid` = `r-` + 8–32 chars of `[a-z0-9]` (phone generates it).

## Write API
`POST https://patelpb.com/api/newsroom/put` with header `x-newsroom-key`, header
`x-amz-content-sha256` (hex SHA-256 of the body; needed by the Lambda OAC), body
`{ "name": <name>, "doc": <object> }`.
- Allowed names (regex): `^(beat\.json|inbox/r-[a-z0-9]{8,32}\.json|out/index\.json|out/r-[a-z0-9]{8,32}/(status|plane|edition)\.json)$`
- `beat.json` doc must be a small plain object; every other doc must be a valid envelope whose
  `name` equals the target name.
- Putting `inbox/<rid>.json` also appends `rid` to `inbox/index.json` (dedup, keep last 50, `seq += 1`).
- Responses JSON, `Cache-Control: no-store`: 200 `{status:"ok"}`, 400, 401, 405, 413 (> 900 KB), 500.
  Never 403/404 (the distribution rewrites those to /404.html).

## Plaintext shapes
```ts
Request        { rid, text, created: ISO, opts?: { window_hours?: number } }
Status         { rid, state: "queued"|"running"|"done"|"failed", phase: string, progress: 0..1,
                 message: string, updated: ISO, started?: ISO, finished?: ISO }
EditionSummary { rid, title, request, created: ISO, state, stories: number }
Plane          { nodes: PlaneNode[], edges: PlaneEdge[], generatedAt: number }
  PlaneNode    { id, kind: "agent"|"tool"|"doc", label, group, groupLabel,
                 role?: "role_1"|"role_2"|"role_3"|"role_4", tier?: number, state?: "working"|"idle"|"done" }
               // agents: id/label "agent_7"; tools: "tool_3" (group "tools"); docs: label "doctype_2",
               // group "doctype_2". No names, models, URLs, paths, extensions, queries or text.
  PlaneEdge    { src, dst, kind: "call"|"reports"|"message", count, active: bool, pulse: bool }
Edition        { rid, request, title, created: ISO, window: {start: ISO, end: ISO},
                 headline: Article, articles: Article[], sources: Source[], facts: Fact[],
                 notes: string[],            // e.g. "Only 4 stories passed verification."
                 stats: { agents, minutes, cost_usd: number|null, billing: "plan"|"api" } }
Article        { id, headline, dek, desk, significance: 1..5, reliability: "verified"|"low",
                 paragraphs: { sentences: { text, facts: string[] }[] }[] }
Fact           { id, statement, scope: "major"|"minor", reliability: "verified"|"low",
                 sources: { source: string, quote: string }[] }
Source         { id, url, domain, title, outlet, published: ISO|null, fetched: ISO,
                 kind: "report"|"official"|"opinion"|"other"|"social"|"forum"|"listing"|"aggregator",
                 reliability: "verified"|"low" }
```
Every sentence cites ≥ 1 fact; every fact has ≥ 1 source quote (≥ 2 independent for "major").
`headline` + `articles` hold at most 5 stories (whatever passed; fewer is normal). A fact is "low"
when reliable sources (report/official) alone don't meet its bar; an article is "low" when any of
its facts is. The phone flags low articles, facts and sources as "less reliable".
The phone renders sentence → superscript fact numbers → tap shows statement, quotes, links.
