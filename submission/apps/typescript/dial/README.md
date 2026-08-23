# Dial

Ask for something that needs a phone call. Dial finds who to ring, rings several
of them, and tells you what each one actually said.

```
"Find the cheapest place near me that can replace an iPhone 13 screen today."

  12 repair shops found near Dublin 2
  4 contacted · 3 answered · 2 gave a comparable price

  FixLab — EUR 89.00
  ✓ Same day  ✓ 90-day warranty  ✓ 2.1 km away

  Lowest verified quote among the 2 businesses that gave Dial a comparable
  price. Verified by phone at 15:42.
```

Read that last sentence again, because it is the whole point. Dial does not say
it found the cheapest shop in the city. It has no way to know that. It rang four
shops, three picked up, two would quote over the phone, and of those two this was
the cheaper. That is a claim it can support, so that is the claim it makes.

## Why this is not one more "call a restaurant" demo

CALL-E holds the conversation. It does not decide who to call, whether an answer
was really an answer, or what five answers mean together. Something has to do
that, and if it is hard-coded per vertical you have a demo rather than a product.

Dial puts that logic above CALL-E and keeps it domain-agnostic. Adding plumbers
to a system that knew about phone repair is two table entries:

- **a call family** — what to ask, and the result schema to extract, in
  `packages/schemas/src/call-families.ts`
- **a category mapping** — how the domain maps to OpenStreetMap tags and Google
  Places types, in `packages/search/src/categories.ts`

Ranking, wave dispatch, evidence validation, comparison, the authorization gate
and both UIs already handle it. Seven families and fourteen domains ship.

## The three things it refuses to do

**It will not turn a non-answer into an answer.** When CALL-E cannot produce a
schema-valid result it returns `structured_result: null`. That is the honest "I
could not establish this" signal, and Dial propagates it as `needs_review`. The
comparison engine drops such a call rather than reading a missing price as zero.
A shop that said "come in and we'll look at it" does not silently become the
cheapest quote.

**It will not convert currencies.** If quotes come back in euro and sterling,
Dial compares within the majority currency and says so in the caveats. Applying
an invented rate and ranking on the result would fabricate the exact number the
user is relying on.

**It will not let a model authorise anything.** Side effect, sensitivity and
authorization requirement are *inputs* to a policy engine written in plain
TypeScript that reads stored user rows. "Find the cheapest plumber" runs
unattended. "Hire the cheapest plumber" stops and asks — and asks before the
first call, not after.

## Side effects, stated plainly

**This app makes real phone calls to real businesses, and they cost credit.**

- Up to `MAX_CALLS_PER_TASK` calls per task (default 5), dispatched in waves of
  `CALL_WAVE_SIZE` (default 3), stopping early once two useful answers are in.
- A per-user daily ceiling, reserved atomically so two workers cannot both spend
  the last of it.
- Every call opens by identifying itself as an AI assistant calling on behalf of
  a customer. This is not configurable.
- CALL-E exposes no cancellation for a call already in flight, so Dial does not
  render a button claiming otherwise. Cancelling a task stops everything not yet
  dialled and reports how many were already connecting.
- Premium-rate and reserved-fiction number ranges are refused outright.
- No bulk calling, no contact-list upload, no caller-ID spoofing, no
  retry-until-answer.

## Running it without calling anyone

The no-call path is the **default**, not a flag you have to remember:

```bash
cp .env.example .env      # TEST_PROVIDER=mock is already set
npm install
npm run build:packages
npm run db:migrate
npm run dev:api & npm run dev:worker & npm run dev:web
```

`FakeCallProvider` is deterministic and deliberately produces the unhappy
outcomes too — no answer, voicemail, refusals, unparseable results — because
those are the paths most likely to be wrong.

`TEST_PROVIDER=real` **without** `CALLE_API_KEY` throws at boot rather than
quietly running fake calls behind a UI that says LIVE. `GET /health` reports
which integrations are actually configured, so it is never ambiguous.

Business discovery is real either way: OpenStreetMap needs no key, and a live
query for phone repair near Dublin 2 returns real shops with real numbers.

## Placing one real call

```bash
TEST_PROVIDER=real npm run calle:verify -- +353871234567
```

One call, to one number typed on the command line, after a five-second abort
window. It refuses to take a number from discovery — ringing a real business has
to be a deliberate act, not a side effect of a script.

## What is supported

- **Provider:** CALL-E, via the official `@call-e/calle@^0.7.0` SDK. Built
  against the shipped type definitions, because the published package is ahead
  of the documentation.
- **Discovery:** OpenStreetMap (no key) and Google Places (optional).
- **Language model:** Google Gemini (`@google/genai`, default
  `gemini-3.7-flash`), for task interpretation only. Without a key the API
  returns `503 llm_not_configured` — there is no rule-based fallback pretending
  to be language understanding.
- **Runtime:** Node ≥ 20.11. Postgres in production; PGlite in development, which
  is real Postgres compiled to WASM.
- **Clients:** a Next.js web app and an Expo / React Native mobile app on one
  account and one database.

## The webhook boundary

CALL-E's deliveries are unsigned — the SDK's `webhooks.verify()` is deprecated
for exactly that reason. Dial treats a delivery as an untrusted hint that
something finished: it checks structure, requires `CALL-E-Event-Id` to match the
body, claims the event id so a replay is a no-op, and then **re-fetches the call
with its own API key** before writing anything.

A test posts a hostile delivery claiming a €1 quote. The stored price stays the
€95 the authenticated re-fetch returned.

## Verification status

158 automated checks: 134 unit and integration (against real PostgreSQL, the
real HTTP layer and the real worker loop) plus 24 end-to-end against a running
stack. Lint and typecheck clean. Both mobile platforms bundle to Hermes
bytecode.

**No real phone call has been placed**, and no real business has been rung. That
needs an API key and a number a human has authorised. The procedure is in
`docs/TESTING.md`, which also lists every check that is BLOCKED and exactly what
each one is waiting on.

Sample numbers throughout use the reserved `+1 555 01xx` fiction range, and API
responses mask real numbers to `+35***00`.
