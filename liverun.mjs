/**
 * Live end-to-end run against the real interpreter and the real directory,
 * with the phone provider faked. No coordinates are seeded, so the location has
 * to come out of the instruction itself.
 *
 *   node liverun.mjs "find me a jewelry store based in dubai"
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
process.env.TEST_PROVIDER = 'mock';
process.env.CALL_POLL_DELAY_MS = '1';
process.env.NODE_ENV = 'test';

const instruction = process.argv[2] ?? 'find me a jewelry store based in dubai';

const { sql } = await import('drizzle-orm');
const { loadConfig } = await import('./packages/config/dist/index.js');
const db_ = await import('./packages/database/dist/index.js');
const { FakeCallProvider } = await import('./packages/calle/dist/index.js');
const { DiscoveryService } = await import('./packages/search/dist/index.js');
const { resolveInterpreter } = await import('./packages/ai/dist/index.js');
const orch = await import('./packages/orchestrator/dist/index.js');

const config = loadConfig(process.env);
const handle = await db_.createDatabase({ url: '', dataDir: 'memory://' });
await db_.runMigrations(handle.db);
const ctx = {
  db: handle.db,
  config,
  provider: new FakeCallProvider(),
  discovery: new DiscoveryService(config),
  // Via the factory, so the fallback model chain is wired exactly as in production.
  interpreter: resolveInterpreter(config),
  publish: () => {},
};

const userId = orch.newId('usr');
await handle.db
  .insert(db_.users)
  .values({ id: userId, email: 'd@e.com', passwordHash: 'x', name: 'Fares' });
await orch.ensureSettings(handle.db, userId);
const taskId = orch.newId('task');
// Deliberately no latitude/longitude: the place must come from the sentence.
await handle.db
  .insert(db_.tasks)
  .values({ id: taskId, userId, instruction, state: 'created', idempotencyKey: 'run-' + Date.now() });
await db_.enqueueJob(handle.db, 'task.interpret', { taskId }, { dedupeKey: 'i:' + taskId });

const runner = new orch.Runner(ctx, { batchSize: 5, pollIntervalMs: 5 });
const terminal = [
  'completed',
  'partially_completed',
  'failed',
  'canceled',
  'needs_user_input',
  'awaiting_confirmation',
];
for (let round = 0; round < 12; round += 1) {
  await runner.drain(400);
  const t = await orch.getTask(handle.db, taskId);
  if (terminal.includes(t.state)) break;
  await handle.db.execute(sql`UPDATE jobs SET run_at = now() WHERE state='pending'`);
  await new Promise((r) => setTimeout(r, 3000));
}

const detail = await orch.toTaskDetail(handle.db, await orch.getTask(handle.db, taskId));
console.log('\n================================================');
console.log('INSTRUCTION :', instruction);
console.log('state       :', detail.state, '|', detail.stateLabel);
console.log('headline    :', detail.headline);
console.log('interpreted location:', JSON.stringify(detail.interpreted?.location));
console.log('\nPROGRESS');
for (const e of detail.events) console.log('  -', e.message);
console.log('\nDISCOVERED:', detail.candidates.length, '| CALLS:', detail.calls.length);
for (const c of detail.candidates.slice(0, 6))
  console.log(`  - ${c.candidate.name} | ${c.candidate.phoneE164 ?? 'no phone'}`);
const rendered = JSON.stringify(detail);
console.log('\nASKED FOR A PLACE? ', /Where should Dial search|postcode|which town or city/i.test(rendered));
console.log('RAW JSON LEAKED?   ', /[{]"error"|UNAVAILABLE|high demand/.test(rendered));
await handle.close();
