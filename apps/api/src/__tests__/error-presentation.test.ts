import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { presentableFailure } from '@dial/orchestrator';
import { InterpreterBusyError, InterpretationFailedError } from '@dial/ai';
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
 * Section 36: a user must never be shown machine vocabulary.
 *
 * The trigger for these was a real incident — a Gemini 503 body was rendered
 * verbatim in the progress list as
 * `{"error":{"code":503,"message":"This model is currently experiencing high
 * demand..."}}`, and the task was marked permanently failed for what was a
 * transient overload.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('presentableFailure', () => {
  it('replaces a raw provider JSON body', () => {
    const raw =
      '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}';
    const shown = presentableFailure(raw);
    expect(shown).not.toContain('UNAVAILABLE');
    expect(shown).not.toContain('{');
    expect(shown).toMatch(/Dial ran into a problem/i);
  });

  it('replaces a stack trace', () => {
    expect(presentableFailure('TypeError: x is not a function\n    at foo (/app/x.js:12:9)')).toMatch(
      /Dial ran into a problem/i,
    );
  });

  it('replaces a database error', () => {
    expect(presentableFailure('relation "tasks" does not exist')).toMatch(/Dial ran into a problem/i);
  });

  it('replaces a bare connection error code', () => {
    expect(presentableFailure('connect ECONNREFUSED 127.0.0.1:4000')).toMatch(
      /Dial ran into a problem/i,
    );
  });

  it('replaces an empty message', () => {
    expect(presentableFailure('')).toMatch(/Dial ran into a problem/i);
    expect(presentableFailure('   ')).toMatch(/Dial ran into a problem/i);
  });

  it('replaces anything implausibly long for a user-facing line', () => {
    expect(presentableFailure('a'.repeat(400))).toMatch(/Dial ran into a problem/i);
  });

  it('leaves our own wording untouched', () => {
    for (const message of [
      'Dial could not find any phone repair shop near Dublin 2.',
      "You've reached today's limit on calls Dial can place. It resets tomorrow.",
      'Your settings do not allow Dial to make phone calls.',
      'Dial could not understand that request. Try rephrasing it in a sentence or two.',
    ]) {
      expect(presentableFailure(message)).toBe(message);
    }
  });
});

describe('a transient model outage', () => {
  /** Fails with a retryable error `failures` times, then succeeds. */
  function flakyInterpreter(failures: number) {
    let calls = 0;
    return {
      name: 'flaky',
      async interpret() {
        calls += 1;
        if (calls <= failures) throw new InterpreterBusyError(503);
        return {
          task: {
            objective: 'Find an iPhone repair shop',
            taskFamily: 'research_compare' as const,
            domain: 'phone_repair',
            searchQuery: 'phone repair shop',
            location: { raw: 'Dublin 2', latitude: null, longitude: null, label: null, radiusKm: 10 },
            constraints: {
              budget: null,
              date: null,
              timeWindow: null,
              distanceKm: 10,
              partySize: null,
              preferredBrands: [],
              excludedBusinesses: [],
              candidateLimit: null,
              additional: {},
            },
            successCondition: 'A price is obtained',
            requestedSideEffect: 'information_only' as const,
            sensitivity: 'normal' as const,
            authorizationRequirement: 'none' as const,
            clarificationNeeded: null,
            isEmergency: false,
          },
          callFamily: 'repair_quote' as const,
        };
      },
      get callCount() {
        return calls;
      },
    };
  }

  /** The queue backs off; tests do not wait it out. */
  async function fastForwardJobs(harness: Harness) {
    await harness.handle.db.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`);
  }

  it('does not fail the task — it retries and then succeeds', async () => {
    const interpreter = flakyInterpreter(2);
    h = await createHarness({
      interpreter,
      discovery: stubDiscovery({ candidates: [candidate({ id: 'r1', name: 'FixLab' })] }),
    });
    const { token } = await signUp(h);
    const created = await createTask(h, token, 'fix my iphone screen nearby');

    // First attempt hits the outage.
    await h.runner.drain();
    let detail = await getTaskDetail(h, token, created.id);
    expect(detail.state).not.toBe('failed');

    // The user is told something honest while it waits.
    expect(detail.events.map((e: any) => e.message).join(' ')).toMatch(/busy service|retry/i);

    // Let the backoff elapse; the retries then get through.
    for (let i = 0; i < 4; i += 1) {
      await fastForwardJobs(h);
      await h.runner.drain();
    }

    detail = await getTaskDetail(h, token, created.id);
    expect(interpreter.callCount).toBeGreaterThan(1);
    expect(['completed', 'partially_completed']).toContain(detail.state);
  });

  it('never shows the raw provider payload, even once exhausted', async () => {
    // Always fails, so the job exhausts its retries.
    h = await createHarness({
      interpreter: flakyInterpreter(Number.MAX_SAFE_INTEGER),
      discovery: stubDiscovery({ candidates: [candidate()] }),
    });
    const { token } = await signUp(h);
    const created = await createTask(h, token, 'fix my iphone screen nearby');

    for (let i = 0; i < 10; i += 1) {
      await fastForwardJobs(h);
      await h.runner.drain();
    }

    const detail = await getTaskDetail(h, token, created.id);
    const rendered = JSON.stringify(detail);

    // The exact strings from the real incident must not appear anywhere.
    expect(rendered).not.toContain('UNAVAILABLE');
    expect(rendered).not.toContain('"code":503');
    expect(rendered).not.toMatch(/experiencing high demand/i);

    // And it reaches a terminal state rather than spinning forever.
    expect(detail.state).toBe('failed');
    expect(detail.headline).toMatch(/try again in a few minutes/i);
  });

  it('a permanent interpretation failure fails fast, with our wording', async () => {
    h = await createHarness({
      interpreter: {
        name: 'broken',
        async interpret(): Promise<never> {
          throw new InterpretationFailedError(
            'Dial could not understand that request. Try rephrasing it in a sentence or two.',
          );
        },
      },
      discovery: stubDiscovery({ candidates: [candidate()] }),
    });
    const { token } = await signUp(h);
    const created = await createTask(h, token, '???');
    await h.runner.drain();

    const detail = await getTaskDetail(h, token, created.id);
    expect(detail.state).toBe('failed');
    expect(detail.headline).toMatch(/could not understand that request/i);
    expect(detail.headline).not.toContain('{');
  });
});
