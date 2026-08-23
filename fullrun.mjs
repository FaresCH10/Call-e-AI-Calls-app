import { readFileSync } from 'node:fs';
const env = Object.fromEntries(
  readFileSync('.env','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('='))
    .map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
for (const [k,v] of Object.entries(env)) if (process.env[k]===undefined) process.env[k]=v;
process.env.TEST_PROVIDER='mock'; process.env.CALL_POLL_DELAY_MS='1'; process.env.NODE_ENV='test';
if (process.argv[2]) process.env.LLM_MODEL = process.argv[2];

const { sql } = await import('drizzle-orm');
const { loadConfig } = await import('./packages/config/dist/index.js');
const db_ = await import('./packages/database/dist/index.js');
const { FakeCallProvider } = await import('./packages/calle/dist/index.js');
const { DiscoveryService } = await import('./packages/search/dist/index.js');
const { GeminiTaskInterpreter } = await import('./packages/ai/dist/interpreter.js');
const orch = await import('./packages/orchestrator/dist/index.js');

const config = loadConfig(process.env);
console.log('model:', config.llm.model);
const handle = await db_.createDatabase({ url:'', dataDir:'memory://' });
await db_.runMigrations(handle.db);
const ctx = { db: handle.db, config, provider: new FakeCallProvider(),
  discovery: new DiscoveryService(config),
  interpreter: new GeminiTaskInterpreter(config.llm.apiKey, config.llm.model),
  publish: () => {} };

const userId = orch.newId('usr');
await handle.db.insert(db_.users).values({ id:userId, email:'d@e.com', passwordHash:'x', name:'Fares' });
await orch.ensureSettings(handle.db, userId);
const taskId = orch.newId('task');
await handle.db.insert(db_.tasks).values({ id:taskId, userId,
  instruction:'i want to call for someone to repair my iphone nearby', state:'created',
  latitude:25.2048, longitude:55.2708, locationLabel:'Dubai, United Arab Emirates',
  idempotencyKey:'run-'+Date.now() });
await db_.enqueueJob(handle.db, 'task.interpret', { taskId }, { dedupeKey:'i:'+taskId });

const runner = new orch.Runner(ctx, { batchSize:5, pollIntervalMs:5 });
const terminal = ['completed','partially_completed','failed','canceled','needs_user_input','awaiting_confirmation'];
for (let round=0; round<12; round++) {
  await runner.drain(400);
  const t = await orch.getTask(handle.db, taskId);
  if (terminal.includes(t.state)) break;
  await handle.db.execute(sql`UPDATE jobs SET run_at = now() WHERE state='pending'`);
  await new Promise(r=>setTimeout(r, 4000));   // give the provider room to recover
}

const detail = await orch.toTaskDetail(handle.db, await orch.getTask(handle.db, taskId));
console.log('\n================ RESULT ================');
console.log('state    :', detail.state, '|', detail.stateLabel);
console.log('headline :', detail.headline);
console.log('\nPROGRESS'); for (const e of detail.events) console.log('  ✓', e.message);
console.log('\nDISCOVERED:', detail.candidates.length, 'real businesses from OpenStreetMap');
for (const c of detail.candidates.slice(0,8))
  console.log(`  - ${c.candidate.name} | ${c.candidate.phoneE164 ?? 'no phone'} | ${c.candidate.distanceMeters ?? '?'}m | ${c.excludedReason ?? 'callable'}`);
console.log('\nCALLS:', detail.calls.length);
for (const c of detail.calls) console.log(`  - ${c.businessName} | ${c.phoneMasked} | ${c.disposition}`);
if (detail.result) {
  console.log('\nTALLY:', JSON.stringify(detail.result.tally));
  if (detail.result.best) {
    console.log('BEST :', detail.result.best.candidate.name, detail.result.best.normalizedCurrency ?? '', detail.result.best.normalizedPrice ?? '');
    console.log('WHY  :', detail.result.best.rankReasons.join(' · '));
  }
  if (detail.result.caveats.length) console.log('CAVEATS:', detail.result.caveats.join(' | '));
}
console.log('\nRaw JSON leaked?', /[{]"error"|UNAVAILABLE|high demand/.test(JSON.stringify(detail)));
await handle.close();
