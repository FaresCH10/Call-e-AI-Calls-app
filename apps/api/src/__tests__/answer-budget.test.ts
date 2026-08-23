import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { callPhase } from '@dial/orchestrator';
import type { CallProvider, ProviderCallSnapshot } from '@dial/calle';
import {
  createHarness,
  signUp,
  createTask,
  getTaskDetail,
  stubDiscovery,
  candidate,
  type Harness,
} from './harness.js';

/**
 * What the answer budget is allowed to cut off.
 *
 * From a real run: five businesses were all reported "No answer within 60
 * seconds". CALL-E's own record showed three of them had answered -- one held a
 * 96-turn conversation lasting six and a half minutes and quoted a price. Every
 * local row still read `provider_status=queued`, because the budget had been
 * spent while the calls were sitting in CALL-E's queue, before a single phone
 * rang. Dial gave up, CALL-E dialled anyway (it cannot be cancelled), and the
 * answer was thrown away.
 *
 * The budget bounds one thing: how long Dial waits for somebody to pick up.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function snapshot(over: Partial<ProviderCallSnapshot> = {}): ProviderCallSnapshot {
  return {
    providerCallId: 'call_test',
    status: 'queued',
    structuredResult: null,
    summary: null,
    taskCompleted: null,
    completionConfidence: null,
    evidence: [],
    attempts: [],
    failureCode: null,
    failureMessage: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    ...over,
  };
}

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    phoneMasked: '+97***42',
    status: 'queued',
    startedAt: null,
    completedAt: null,
    summary: null,
    transcript: [],
    failureCode: null,
    failureMessage: null,
    ...over,
  };
}

describe('callPhase', () => {
  it('treats a call still in the provider queue as not yet ringing', () => {
    expect(callPhase(snapshot({ status: 'queued' }))).toBe('queued');
    expect(
      callPhase(snapshot({ status: 'in_progress', attempts: [attempt({ status: 'queued' })] as any })),
    ).toBe('queued');
  });

  it('counts a dialling attempt as ringing', () => {
    expect(
      callPhase(
        snapshot({ status: 'in_progress', attempts: [attempt({ status: 'dialing' })] as any }),
      ),
    ).toBe('ringing');
  });

  it('counts a picked-up call as answered', () => {
    expect(
      callPhase(
        snapshot({ status: 'in_progress', attempts: [attempt({ status: 'in_progress' })] as any }),
      ),
    ).toBe('answered');
  });

  it('treats transcript turns as proof somebody answered', () => {
    // The Karcher Store case: 96 turns exchanged, reported as no answer.
    expect(
      callPhase(
        snapshot({
          status: 'in_progress',
          attempts: [attempt({ status: 'dialing', transcript: [{ speaker: 'business' }] })] as any,
        }),
      ),
    ).toBe('answered');
  });
});

/** Sits in the provider's queue forever without ever dialling. */
const neverLeavesQueue: CallProvider = {
  name: 'fake',
  placesRealCalls: false,
  async create(request) {
    return snapshot({ providerCallId: `q_${request.idempotencyKey.replace(/[^a-z0-9]/gi, '')}` });
  },
  async get(providerCallId) {
    return snapshot({ providerCallId, status: 'queued' });
  },
};

/** Picks up quickly, then talks for far longer than the answer budget. */
const answersThenTalks: CallProvider = {
  name: 'fake',
  placesRealCalls: false,
  async create(request) {
    return snapshot({ providerCallId: `t_${request.idempotencyKey.replace(/[^a-z0-9]/gi, '')}` });
  },
  async get(providerCallId) {
    return snapshot({
      providerCallId,
      status: 'in_progress',
      attempts: [
        attempt({ status: 'in_progress', transcript: [{ speaker: 'business', text: 'hello' }] }),
      ] as any,
    });
  },
};

async function dueNow(harness: Harness) {
  await harness.handle.db.execute(
    sql`UPDATE jobs SET run_at = now() WHERE state = 'pending' AND kind <> 'task.timeout'`,
  );
}

async function agePendingCalls(harness: Harness, seconds: number) {
  await harness.handle.db.execute(sql`
    UPDATE calls
    SET waiting_since = now() - (${seconds} * interval '1 second'),
        dispatched_at  = now() - (${seconds} * interval '1 second')
    WHERE disposition = 'pending'
  `);
}

const ENV = {
  CALL_POLL_DELAY_MS: '60000',
  CALL_ANSWER_TIMEOUT_MS: '30000',
  CALL_MAX_ATTEMPTS_PER_BUSINESS: '2',
  MAX_CALLS_PER_TASK: '1',
};

describe('the answer budget', () => {
  it('is not spent while the call waits in the provider queue', async () => {
    // The exact failure: nothing has rung, so nothing has gone unanswered.
    h = await createHarness({
      provider: neverLeavesQueue,
      env: ENV,
      discovery: stubDiscovery({
        candidates: [candidate({ id: 'a', name: 'Still Queued', phoneE164: '+35316793500' })],
      }),
    });
    const { token } = await signUp(h);
    const created = await createTask(h, token, 'Find an iPhone repair shop');
    await h.runner.drain();

    for (let i = 0; i < 4; i += 1) {
      await agePendingCalls(h, 120);
      await dueNow(h);
      await h.runner.drain();
    }

    const detail = await getTaskDetail(h, token, created.id);
    expect(detail.calls[0]?.disposition).not.toBe('no_answer');
    expect(JSON.stringify(detail)).not.toMatch(/no answer within/i);
  });

  it('never cuts off a call that has been answered', async () => {
    // Six minutes of conversation is the call going well, not going wrong.
    h = await createHarness({
      provider: answersThenTalks,
      env: ENV,
      discovery: stubDiscovery({
        candidates: [candidate({ id: 'b', name: 'Talkative Shop', phoneE164: '+35316793501' })],
      }),
    });
    const { token } = await signUp(h);
    const created = await createTask(h, token, 'Find an iPhone repair shop');
    await h.runner.drain();

    for (let i = 0; i < 4; i += 1) {
      await agePendingCalls(h, 600);
      await dueNow(h);
      await h.runner.drain();
    }

    const detail = await getTaskDetail(h, token, created.id);
    expect(detail.calls[0]?.disposition).not.toBe('no_answer');
    expect(detail.calls[0]?.failureCode).not.toBe('answer_timeout');
  });

  it('still gives up on a phone that genuinely rings out', async () => {
    // The feature has to keep working: this one is dialling, not queued, and
    // nobody picks up.
    const ringsForever: CallProvider = {
      name: 'fake',
      placesRealCalls: false,
      async create(request) {
        return snapshot({
          providerCallId: `r_${request.idempotencyKey.replace(/[^a-z0-9]/gi, '')}`,
          status: 'in_progress',
          attempts: [attempt({ status: 'dialing' })] as any,
        });
      },
      async get(providerCallId) {
        return snapshot({
          providerCallId,
          status: 'in_progress',
          attempts: [attempt({ status: 'dialing' })] as any,
        });
      },
    };

    h = await createHarness({
      provider: ringsForever,
      env: ENV,
      discovery: stubDiscovery({
        candidates: [candidate({ id: 'c', name: 'Rings Out', phoneE164: '+35316793502' })],
      }),
    });
    const { token } = await signUp(h);
    const created = await createTask(h, token, 'Find an iPhone repair shop');
    await h.runner.drain();

    for (let i = 0; i < 4; i += 1) {
      await agePendingCalls(h, 61);
      await dueNow(h);
      await h.runner.drain();
    }

    const detail = await getTaskDetail(h, token, created.id);
    expect(detail.calls[0]?.disposition).toBe('no_answer');
    expect(detail.calls[0]?.failureCode).toBe('answer_timeout');
  });
});
