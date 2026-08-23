# Dial

**Tell Dial what you need done in the real world. It finds who to contact, calls them, and returns the verified result.**

```
"Find the cheapest place near me that can replace an iPhone 13 screen today."

   12 repair shops found near Dublin 2
   4 contacted · 3 answered · 2 gave a comparable price

   FixLab — EUR 89.00
   ✓ Same day  ✓ 90-day warranty  ✓ 2.1 km away

   Lowest verified quote among the 2 businesses that gave Dial a
   comparable price. Verified by phone at 15:42.
```

Dial does not tell you it found the cheapest shop in the city. It tells you the
lowest price among the shops it actually rang, how many answered, and what each
one said. That distinction is the product.

---

## What is real

- **Real business discovery.** OpenStreetMap (Nominatim + Overpass) returns real
  businesses with real phone numbers, live, with no API key. A Google Places
  adapter activates automatically when a key is supplied.
- **Real phone calls** through the official `@call-e/calle` SDK, built against
  its shipped type definitions — verified, not inferred from prose docs.
- **Real PostgreSQL**, including in tests, via PGlite (Postgres compiled to
  WASM). Real constraints, real transactions, real `FOR UPDATE SKIP LOCKED`.
- **Real native mobile app.** Expo / React Native, Hermes bytecode, native tabs
  and permissions. Not a WebView.
- **134 automated tests**, covering the pipeline, the webhook boundary, the
  authorization gate and every failure path.

## What is not done yet

Honesty is the point of this product, so:

- **A real call has now been placed.** `call_3kj1Yo8peCmczk6WKjjroA`, to an
  owner-authorised number, through the live CALL-E API with `TEST_PROVIDER=real`.
  It reached the handset and was **declined by the recipient** — so the happy
  path (a conversation, a transcript, an extracted answer) is still unverified,
  but the dispatch, the terminal reconciliation and the honest-failure handling
  all are. See [`docs/TESTING.md`](docs/TESTING.md).
- **No task has been interpreted by a real model.** That needs `LLM_API_KEY`
  (Google Gemini).
  Without it, task creation returns a precise `503 llm_not_configured` rather
  than quietly falling back to a hard-coded classifier.
- **No store build has been produced.** Both platforms bundle; producing a
  signed `.ipa`/`.aab` needs developer credentials. See
  [`docs/MOBILE_RELEASE.md`](docs/MOBILE_RELEASE.md).

---

## Architecture

Dial is the orchestrator. CALL-E is the phone-work execution engine. The
separation is deliberate and load-bearing: CALL-E holds conversations, Dial
decides who to ring, what counts as an answer, and what the answers mean
together.

```
 User instruction
        ↓
 Task Interpreter            packages/ai        schema-constrained, model-driven
        ↓
 Constraint + Policy         packages/domain    plain TypeScript, no model input
        ↓
 Business Discovery          packages/search    OSM / Google Places
        ↓
 Candidate Verification      packages/domain    E.164 only, never a guess
        ↓
 Call Planner                packages/calle     goals + boundaries, not a script
        ↓
      CALL-E                 @call-e/calle
        ↓
 Structured outcomes         packages/schemas   per-family result schemas
        ↓
 Evidence Validator          packages/domain    null result ⇒ "needs review"
        ↓
 Comparison Engine           packages/domain    honest tallies, no conversion
        ↓
 Final result
```

```
apps/
  api/        Fastify · auth · REST · SSE · webhook receiver
  worker/     durable job loop — all phone work happens here
  web/        Next.js 16 App Router · BFF proxy · server-rendered
  mobile/     Expo Router · React Native · secure-store
packages/
  config/         env loading + boot-time coherence checks
  schemas/        Zod contracts · DialTask · CALL-E result schemas
  domain/         phone · policy · ranking · comparison · injection defence
  database/       Drizzle schema · migrations · Postgres job queue
  search/         discovery providers · SSRF-guarded HTTP
  ai/             Gemini task interpreter
  calle/          CALL-E provider · fake provider · call planner
  orchestrator/   the task pipeline and worker runner
  api-client/     one typed client, used by web and mobile
  ui/             design tokens shared by both clients
```

**No duplicated business logic.** Rules live in `packages/domain` and are
enforced only on the server. Clients import them purely to grey out buttons; a
hostile client gains nothing.

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/DECISIONS.md`](docs/DECISIONS.md)

---

## Setup

**Requires:** Node ≥ 20.11 (developed on 24.5). No Docker, no Postgres server.

```bash
cp .env.example .env

# Generate the two secrets
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # ENCRYPTION_KEY

npm install
npm run build:packages
npm run db:migrate
```

### Required credentials

| Variable | Needed for | Without it |
| --- | --- | --- |
| `LLM_API_KEY` | Understanding requests | `POST /api/tasks` returns `503 llm_not_configured` |
| `CALLE_API_KEY` | Placing real calls | Runs the fake provider; `TEST_PROVIDER=real` refuses to boot |
| `OSM_CONTACT_EMAIL` | OpenStreetMap usage policy | Discovery works but is not a good citizen — set it |
| `GOOGLE_PLACES_API_KEY` | Ratings, review counts, better numbers | Falls back to OpenStreetMap alone |

`LLM_API_KEY` is a Google Gemini API key from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). The default
model is `gemini-3.7-flash`; set `LLM_MODEL` to use another.

---

## Running it

```bash
npm run dev:api      # http://localhost:4000 — runs the job loop in-process on PGlite
npm run dev:web      # http://localhost:3000
npm run dev:mobile   # Expo — set EXPO_PUBLIC_API_URL to your LAN IP for a device
```

**About the worker.** In production it is a separate process, because phone work
must not depend on an HTTP request staying open and a web deploy must not
abandon calls in flight:

```bash
npm run dev:worker   # requires DATABASE_URL — see below
```

Locally the default database is PGlite, which is embedded and **single-process**:
a second process cannot open the same data directory. So with no `DATABASE_URL`
the API runs the job loop itself and `npm run dev:worker` exits with an
explanation rather than a confusing WASM abort. Point `DATABASE_URL` at a real
Postgres and the two split apart as they do in production. `RUN_WORKER_IN_API`
overrides the default either way.

Check what is actually wired up:

```bash
curl -s localhost:4000/health
```

```json
{
  "callMode": "mock",
  "integrations": {
    "calle": false, "llm": false,
    "discovery": "osm", "queue": "postgres", "database": "pglite"
  }
}
```

`callMode` is never ambiguous. `TEST_PROVIDER=real` without `CALLE_API_KEY`
throws at boot rather than running fake calls behind a UI that claims otherwise.

---

## Placing a real call

Real calls cost money and ring real people. The procedure, in full, is in
[`docs/TESTING.md`](docs/TESTING.md). In short:

```bash
TEST_PROVIDER=real npm run calle:verify -- +353871234567
```

`calle:verify` places one real call to **one number you pass explicitly**, prints
the real CALL-E call id, waits for the terminal result and persists it. It will
not dial a number discovered from a directory — that has to be a deliberate act.

---

## Testing

```bash
npm run lint
npm run typecheck
npm test                # unit + integration, real Postgres via PGlite
npm run e2e             # drives a running server over HTTP
npm run build           # packages + api + worker + web
npm run build:mobile    # Expo bundle, both platforms
```

[`docs/TESTING.md`](docs/TESTING.md) has the full matrix, including what is
BLOCKED and why.

---

## Security

- No secret of any kind reaches a client. The web app talks to a same-origin BFF
  proxy; the API key lives only in `apps/api` and `apps/worker`.
- Webhook deliveries from CALL-E are **unsigned** (the SDK's `verify()` is
  deprecated for that reason). Dial treats a delivery as an untrusted hint,
  requires the `CALL-E-Event-Id` header to match the body, records the event id
  for idempotency, and then **re-fetches the call with its own API key** before
  writing anything.
- Outbound research HTTP is allowlisted by host and re-checked on every redirect
  hop, so a business listing cannot make the server fetch an internal address.
- External text — listings, web pages, transcripts — is wrapped in an untrusted
  block and never carries authority. Budgets, call limits and permissions are
  decided in TypeScript from database rows.

[`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/PRIVACY.md`](docs/PRIVACY.md)

---

## Licence and attribution

Business data from OpenStreetMap is © OpenStreetMap contributors, available
under the Open Database Licence. Every candidate carries its `sourceUrl` so the
provenance is visible in the UI, not just in a footer.
