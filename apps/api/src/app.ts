import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { config as loadConfig, type DialConfig } from '@dial/config';
import {
  tasks,
  users,
  userSettings,
  authorizationRequests,
  calls,
  enqueueJob,
  queueDepth,
  type Db,
} from '@dial/database';
import {
  signUpRequestSchema,
  signInRequestSchema,
  createTaskRequestSchema,
  answerClarificationRequestSchema,
  answerQuestionsRequestSchema,
  authorizationDecisionRequestSchema,
  updateSettingsRequestSchema,
  userPolicySchema,
  TASK_STATE_LABELS,
  type SessionUser,
  type TaskState,
} from '@dial/schemas';
import {
  toTaskSummary,
  toTaskDetail,
  CALL_LANGUAGE_QUESTION_ID,
  getTaskForUser,
  getSettings,
  ensureSettings,
  handleCalleWebhook,
  setState,
  audit,
  newId,
  type OrchestratorContext,
} from '@dial/orchestrator';
import { resolveLanguageAnswer } from '@dial/domain';
import { logger, metricsSnapshot, incrementCounter } from '@dial/observability';
import {
  registerUser,
  authenticate,
  createSession,
  resolveSession,
  revokeSession,
} from './auth.js';
import { RealtimeHub } from './realtime.js';

const SESSION_COOKIE = 'dial_session';

export interface BuildOptions {
  db: Db;
  config?: DialConfig;
  ctx: OrchestratorContext;
  hub: RealtimeHub;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
    sessionToken?: string;
  }
}

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const cfg = options.config ?? loadConfig();
  const { db, ctx, hub } = options;

  const app = Fastify({
    logger: false,
    // Trust the proxy only in production, where one is actually in front.
    trustProxy: cfg.isProduction,
    bodyLimit: 1024 * 512,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // this is a JSON API; the web app sets its own
  });
  await app.register(cookie, { secret: cfg.sessionSecret });
  await app.register(cors, {
    origin: cfg.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.user?.id ?? req.ip,
  });

  /* ------------------------------------------------------------- auth hook */

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const cookieToken = request.cookies?.[SESSION_COOKIE] ?? null;
    const token = bearer ?? cookieToken;
    if (!token) return;
    const user = await resolveSession(db, token);
    if (user) {
      request.user = user;
      request.sessionToken = token;
    }
  });

  function requireUser(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
    if (!request.user) {
      void reply.code(401).send({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
      return null;
    }
    return request.user;
  }

  function fail(reply: FastifyReply, status: number, code: string, message: string) {
    return reply.code(status).send({ error: { code, message } });
  }

  /* ---------------------------------------------------------------- health */

  app.get('/health', async () => {
    const depth = await queueDepth(db).catch(() => ({ pending: -1, running: -1, failed: -1 }));
    return {
      ok: true,
      version: '1.0.0',
      callMode: cfg.callMode,
      integrations: {
        calle: cfg.calle.configured,
        llm: cfg.llm.configured,
        discovery: ctx.discovery.describe(),
        queue: cfg.redisUrl ? 'redis' : 'postgres',
        database: cfg.databaseUrl ? 'postgres' : 'pglite',
      },
      queue: depth,
    };
  });

  app.get('/metrics', async (request, reply) => {
    // Metrics can reveal usage patterns, so they require a session like
    // anything else rather than sitting open on the network.
    if (!requireUser(request, reply)) return;
    return metricsSnapshot();
  });

  /* ------------------------------------------------------------------ auth */

  app.post('/api/auth/sign-up', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const parsed = signUpRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'invalid_request', firstIssue(parsed.error));
    }
    try {
      const user = await registerUser(db, parsed.data);
      const session = await createSession(db, user.id);
      setSessionCookie(reply, session.token, session.expiresAt, cfg);
      await audit(db, user.id, null, 'sign_up');
      return { user, token: session.token };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      return fail(reply, status, status === 409 ? 'email_taken' : 'internal_error', (error as Error).message);
    }
  });

  app.post('/api/auth/sign-in', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const parsed = signInRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', firstIssue(parsed.error));

    const user = await authenticate(db, parsed.data.email, parsed.data.password);
    if (!user) {
      incrementCounter('auth.failed');
      return fail(reply, 401, 'invalid_credentials', 'That email or password is not right.');
    }
    const session = await createSession(db, user.id);
    setSessionCookie(reply, session.token, session.expiresAt, cfg);
    await ensureSettings(db, user.id);
    return { user, token: session.token };
  });

  app.post('/api/auth/sign-out', async (request, reply) => {
    if (request.sessionToken) await revokeSession(db, request.sessionToken);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return { user, token: null };
  });

  /* ----------------------------------------------------------------- tasks */

  app.get('/api/tasks', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 50);
    const conditions = [eq(tasks.userId, user.id)];
    if (query.cursor) conditions.push(lt(tasks.createdAt, query.cursor));

    const rows = await db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      tasks: page.map(toTaskSummary),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.createdAt ?? null) : null,
    };
  });

  app.post('/api/tasks', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const parsed = createTaskRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', firstIssue(parsed.error));
    const body = parsed.data;

    // Ask whether an interpreter actually exists, not whether a key happens to
    // be set — the context owns that decision, and refusing here means a task
    // is never created that the pipeline could not possibly progress.
    if (!ctx.interpreter) {
      return fail(
        reply,
        503,
        'llm_not_configured',
        'Dial cannot understand requests until a language model is configured on the server.',
      );
    }

    // Resolve a typed location before the task is created, so the first thing
    // the user sees already reflects where Dial will search.
    let latitude = body.location?.latitude ?? null;
    let longitude = body.location?.longitude ?? null;
    let locationLabel: string | null = null;

    if (latitude === null && body.location?.text) {
      const geo = await ctx.discovery.geocode(body.location.text).catch(() => null);
      if (geo) {
        latitude = geo.latitude;
        longitude = geo.longitude;
        locationLabel = geo.label;
      }
    }

    const id = newId('task');
    const inserted = await db
      .insert(tasks)
      .values({
        id,
        userId: user.id,
        instruction: body.instruction,
        state: 'created',
        latitude,
        longitude,
        locationLabel,
        idempotencyKey: body.idempotencyKey,
      })
      // A double-tap or a retried request returns the original task.
      .onConflictDoNothing()
      .returning({ id: tasks.id });

    if (inserted.length === 0) {
      const existing = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, user.id), eq(tasks.idempotencyKey, body.idempotencyKey)))
        .limit(1);
      const row = existing[0];
      if (row) return toTaskSummary(row);
      return fail(reply, 409, 'conflict', 'That task could not be created.');
    }

    hub.registerTaskOwner(id, user.id);
    // Interpretation depends on a shared model service that can stay busy for
    // minutes at a time, so it gets a longer retry budget than the default.
    await enqueueJob(db, 'task.interpret', { taskId: id }, { dedupeKey: `interpret:${id}`, maxAttempts: 8 });
    await audit(db, user.id, id, 'task_created');
    incrementCounter('task.created');

    const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return toTaskSummary(rows[0]!);
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const row = await getTaskForUser(db, id, user.id);
    if (!row) return fail(reply, 404, 'not_found', 'That task does not exist.');
    hub.registerTaskOwner(id, user.id);
    return toTaskDetail(db, row);
  });

  app.post('/api/tasks/:id/clarify', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const parsed = answerClarificationRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', firstIssue(parsed.error));

    const row = await getTaskForUser(db, id, user.id);
    if (!row) return fail(reply, 404, 'not_found', 'That task does not exist.');
    if (row.state !== 'needs_user_input') {
      return fail(reply, 409, 'not_awaiting_input', 'That task is not waiting on an answer.');
    }

    // The answer is appended to the instruction and the task re-interpreted,
    // so a clarification cannot smuggle in a different task.
    await db
      .update(tasks)
      .set({
        instruction: `${row.instruction}\n\nAdditional detail from the user: ${parsed.data.answer}`,
        state: 'created',
        clarificationQuestion: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, id));

    await enqueueJob(db, 'task.interpret', { taskId: id }, { dedupeKey: `interpret:${id}:${Date.now()}` });
    const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return toTaskDetail(db, rows[0]!);
  });

  /**
   * Answers to the intake questions. Any subset is accepted, and the user can
   * skip entirely -- the questions exist to improve the outcome, not to gate it.
   */
  app.post('/api/tasks/:id/answers', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const parsed = answerQuestionsRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', firstIssue(parsed.error));

    const row = await getTaskForUser(db, id, user.id);
    if (!row) return fail(reply, 404, 'not_found', 'That task does not exist.');
    if (row.state !== 'needs_user_input') {
      return fail(reply, 409, 'not_awaiting_input', 'That task is not waiting on answers.');
    }

    const questions = (row.clarifyingQuestions as Array<{ id: string }>) ?? [];
    const known = new Set(questions.map((q) => q.id));
    const answers: Record<string, string> = {
      ...((row.clarifyingAnswers as Record<string, string>) ?? {}),
    };

    for (const entry of parsed.data.answers) {
      // Only answers to questions Dial actually asked. An arbitrary key would
      // otherwise become a task constraint and reach the call brief.
      if (!known.has(entry.id)) continue;
      const value = entry.answer.trim();
      if (value) answers[entry.id] = value;
    }

    /*
     * The language question is asked once the search is done, so answering it
     * must not throw that work away. Resuming at interpretation would re-run
     * the model and the whole directory search to reach a decision already
     * made; the answer only changes how the calls are spoken.
     */
    const languageAnswer = answers[CALL_LANGUAGE_QUESTION_ID];
    const chosenLanguage = languageAnswer
      ? resolveLanguageAnswer(languageAnswer, row.countryCode)
      : null;
    const resumeAtCalling = Boolean(languageAnswer) && row.discoveredCount > 0;

    await db
      .update(tasks)
      .set({
        clarifyingAnswers: answers,
        clarifyingQuestions: [],
        // Unrecognised free text leaves the saved preference in place rather
        // than having Dial open a call in a language nobody asked for.
        ...(chosenLanguage ? { callLanguage: chosenLanguage } : {}),
        state: resumeAtCalling ? 'candidates_ready' : 'created',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, id));

    await audit(db, user.id, id, parsed.data.skipped ? 'intake_skipped' : 'intake_answered', {
      answered: Object.keys(answers).length,
    });

    if (resumeAtCalling) {
      await enqueueJob(db, 'task.plan_calls', { taskId: id }, { dedupeKey: `plan:${id}:${Date.now()}` });
    } else {
      await enqueueJob(db, 'task.interpret', { taskId: id }, { dedupeKey: `interpret:${id}:${Date.now()}` });
    }

    const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return toTaskDetail(db, rows[0]!);
  });

  app.post('/api/tasks/:id/authorization', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const parsed = authorizationDecisionRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', firstIssue(parsed.error));

    const row = await getTaskForUser(db, id, user.id);
    if (!row) return fail(reply, 404, 'not_found', 'That task does not exist.');

    const pending = await db
      .select()
      .from(authorizationRequests)
      .where(and(eq(authorizationRequests.taskId, id), eq(authorizationRequests.state, 'pending')))
      .limit(1);
    const auth = pending[0];
    if (!auth) return fail(reply, 409, 'no_pending_authorization', 'Nothing is waiting for approval.');

    if (new Date(auth.expiresAt) < new Date()) {
      await db
        .update(authorizationRequests)
        .set({ state: 'expired', decidedAt: new Date().toISOString() })
        .where(eq(authorizationRequests.id, auth.id));
      return fail(reply, 409, 'expired', 'That approval request has expired. Start the task again.');
    }

    await db
      .update(authorizationRequests)
      .set({
        state: parsed.data.approved ? 'approved' : 'denied',
        decidedAt: new Date().toISOString(),
      })
      .where(eq(authorizationRequests.id, auth.id));

    await audit(db, user.id, id, parsed.data.approved ? 'authorization_approved' : 'authorization_denied', {
      kind: auth.kind,
    });

    if (parsed.data.approved) {
      await setState(ctx, id, 'planning_calls', 'Approved — Dial is getting started');
      await enqueueJob(db, 'task.plan_calls', { taskId: id }, { dedupeKey: `plan:${id}:${Date.now()}` });
    } else {
      await setState(ctx, id, 'canceled', 'You declined, so Dial stopped without calling anyone.', {
        completedAt: new Date().toISOString(),
      });
    }

    const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return toTaskDetail(db, rows[0]!);
  });

  app.post('/api/tasks/:id/cancel', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const row = await getTaskForUser(db, id, user.id);
    if (!row) return fail(reply, 404, 'not_found', 'That task does not exist.');

    const terminal = ['completed', 'partially_completed', 'failed', 'canceled'];
    if (terminal.includes(row.state)) {
      return fail(reply, 409, 'already_finished', 'That task has already finished.');
    }

    // Honest about the limit: CALL-E exposes no cancellation for a call that is
    // already in flight, so cancelling stops everything that has not yet been
    // dialled rather than pretending to pull back a live call.
    const inFlight = await db
      .select()
      .from(calls)
      .where(and(eq(calls.taskId, id), eq(calls.disposition, 'pending')));
    const dialled = inFlight.filter((c) => c.providerCallId).length;

    await setState(ctx, id, 'canceled', 'You canceled this task.', {
      completedAt: new Date().toISOString(),
    });
    await audit(db, user.id, id, 'task_canceled', { callsInFlight: dialled });

    return {
      ok: true,
      callsAlreadyInFlight: dialled,
      note:
        dialled > 0
          ? `${dialled} ${dialled === 1 ? 'call was' : 'calls were'} already connecting and cannot be pulled back.`
          : null,
    };
  });

  app.delete('/api/tasks/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const row = await getTaskForUser(db, id, user.id);
    if (!row) return fail(reply, 404, 'not_found', 'That task does not exist.');
    await db.delete(tasks).where(eq(tasks.id, id));
    await audit(db, user.id, null, 'task_deleted', { taskId: id });
    return { ok: true };
  });

  /* -------------------------------------------------------------- settings */

  app.get('/api/settings', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    await ensureSettings(db, user.id);
    return getSettings(db, user.id);
  });

  app.patch('/api/settings', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const parsed = updateSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', firstIssue(parsed.error));

    await ensureSettings(db, user.id);
    const current = await getSettings(db, user.id);
    const body = parsed.data;

    const policy = body.policy ? userPolicySchema.parse({ ...current.policy, ...body.policy }) : current.policy;

    await db
      .update(userSettings)
      .set({
        policy,
        defaultLatitude: body.defaultLocation?.latitude ?? current.defaultLocation?.latitude ?? null,
        defaultLongitude: body.defaultLocation?.longitude ?? current.defaultLocation?.longitude ?? null,
        defaultLocationLabel: body.defaultLocation?.label ?? current.defaultLocation?.label ?? null,
        preferredLanguage: body.preferredLanguage ?? current.preferredLanguage,
        callingLanguage: body.callingLanguage ?? current.callingLanguage,
        transcriptRetentionDays: body.transcriptRetentionDays ?? current.transcriptRetentionDays,
        notificationsEnabled: body.notificationsEnabled ?? current.notificationsEnabled,
        askClarifyingQuestions:
          body.askClarifyingQuestions ?? current.askClarifyingQuestions,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(userSettings.userId, user.id));

    return getSettings(db, user.id);
  });

  /** Manual location entry / browser geolocation labelling. */
  app.post('/api/location/resolve', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const body = request.body as { text?: string; latitude?: number; longitude?: number };

    try {
      if (typeof body.latitude === 'number' && typeof body.longitude === 'number') {
        const result = await ctx.discovery.reverseGeocode(body.latitude, body.longitude);
        return result ?? { latitude: body.latitude, longitude: body.longitude, label: null, countryCode: null };
      }
      if (body.text) {
        const result = await ctx.discovery.geocode(body.text);
        if (!result) return fail(reply, 404, 'not_found', "Dial couldn't find that place.");
        return result;
      }
      return fail(reply, 400, 'invalid_request', 'Provide a place name or coordinates.');
    } catch {
      return fail(reply, 503, 'search_unavailable', 'The location service is unavailable right now.');
    }
  });

  /* --------------------------------------------------------------- account */

  app.delete('/api/account', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    // Cascades remove tasks, candidates, calls, transcripts and settings.
    await db.delete(users).where(eq(users.id, user.id));
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await audit(db, null, null, 'account_deleted', { userId: user.id });
    return { ok: true };
  });

  /* -------------------------------------------------------------- realtime */

  /**
   * Progress stream.
   *
   * It tails the `task_events` table rather than an in-memory bus, because the
   * work happens in the worker process, not this one. That also means a client
   * that reconnects (tab restored, phone unlocked) resumes from a durable
   * record instead of silently missing whatever happened while it was away —
   * and every line it receives corresponds to a real persisted state change.
   */
  app.get('/api/events', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const query = request.query as { taskId?: string; since?: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`: connected\n\n`);

    let since = query.since ?? new Date(Date.now() - 60_000).toISOString();
    let closed = false;

    const poll = async () => {
      if (closed) return;
      try {
        const rows = await db.execute<{
          id: string;
          task_id: string;
          state: string;
          message: string;
          created_at: string;
        }>(sql`
          SELECT e.id, e.task_id, e.state, e.message, e.created_at
          FROM task_events e
          JOIN tasks t ON t.id = e.task_id
          WHERE t.user_id = ${user.id}
            AND e.created_at > ${since}
            ${query.taskId ? sql`AND e.task_id = ${query.taskId}` : sql``}
          ORDER BY e.created_at
          LIMIT 100
        `);

        for (const row of rows.rows ?? []) {
          since = row.created_at;
          reply.raw.write(
            `data: ${JSON.stringify({
              type: 'state',
              taskId: row.task_id,
              state: row.state,
              message: row.message,
              at: row.created_at,
            })}\n\n`,
          );
        }
      } catch (error) {
        logger.warn('event stream poll failed', { error: (error as Error).message });
      }
    };

    const interval = setInterval(() => void poll(), 1000);
    const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
    void poll();

    request.raw.on('close', () => {
      closed = true;
      clearInterval(interval);
      clearInterval(heartbeat);
    });

    return reply;
  });

  /* -------------------------------------------------------------- webhooks */

  app.post('/api/webhooks/calle', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const outcome = await handleCalleWebhook(ctx, request.body, request.headers);

    if (outcome.status === 'rejected') {
      return reply.code(400).send({ error: { code: 'invalid_webhook', message: outcome.reason } });
    }
    // Duplicates and unknown calls are acknowledged: CALL-E treats any 2xx as
    // delivered, and re-delivery of something we already handled is not an error.
    return reply.code(200).send({ ok: true });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint.' } }),
  );

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as { statusCode?: number; message: string };
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      logger.error('request failed', {
        method: request.method,
        url: request.url,
        error: error.message,
      });
    }
    return reply.code(status).send({
      error: {
        code: status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'invalid_request',
        // Never leak an internal message to the client.
        message: status >= 500 ? 'Something went wrong on Dial’s side.' : error.message,
      },
    });
  });

  return app;
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, cfg: DialConfig) {
  void reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.isProduction,
    expires: expiresAt,
  });
}

function firstIssue(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'request'}: ${issue.message}` : 'Invalid request.';
}

export { TASK_STATE_LABELS };
export type { TaskState };
