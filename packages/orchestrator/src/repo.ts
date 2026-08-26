import { eq, and, desc, sql, lt } from 'drizzle-orm';
import {
  tasks,
  taskEvents,
  businessCandidates,
  calls,
  callAttempts,
  authorizationRequests,
  userSettings,
  users,
  notifications,
  usageCounters,
  auditEvents,
  contacts,
  enqueueJob,
  type Db,
} from '@dial/database';
import {
  TASK_STATE_LABELS,
  userPolicySchema,
  DEFAULT_USER_POLICY,
  type TaskState,
  type BusinessCandidate,
  type RankedCandidate,
  type CallRecord,
  type CallDisposition,
  type UserPolicy,
  type TaskDetail,
  type TaskSummary,
  type UserSettings,
} from '@dial/schemas';
import { maskPhone } from '@dial/domain';
import type { OrchestratorContext } from './context.js';

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ state */

/**
 * Moves a task to a new state and records a user-facing line for it.
 * Every state change goes through here so the timeline can never drift from
 * the task's actual state -- the progress the user sees is the real state
 * machine, not a decorative animation.
 */
export async function setState(
  ctx: OrchestratorContext,
  taskId: string,
  state: TaskState,
  message?: string,
  extra: Partial<typeof tasks.$inferInsert> = {},
): Promise<void> {
  const line = message ?? TASK_STATE_LABELS[state];
  const at = new Date().toISOString();

  await ctx.db
    .update(tasks)
    .set({ state, updatedAt: at, ...extra })
    .where(eq(tasks.id, taskId));

  await ctx.db.insert(taskEvents).values({
    id: newId('evt'),
    taskId,
    state,
    message: line,
  });

  ctx.publish(taskId, { type: 'state', taskId, state, message: line, at });
}

export async function addEvent(
  ctx: OrchestratorContext,
  taskId: string,
  state: TaskState,
  message: string,
): Promise<void> {
  // Repeating the same line is noise, not progress. A retry loop would
  // otherwise stack "Still working..." three times and make a stalled task look
  // like a busy one.
  const [latest] = await ctx.db
    .select({ message: taskEvents.message })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.createdAt))
    .limit(1);
  if (latest?.message === message) return;

  await ctx.db.insert(taskEvents).values({ id: newId('evt'), taskId, state, message });
  ctx.publish(taskId, { type: 'event', taskId, state, message, at: new Date().toISOString() });
}

export async function getTask(db: Db, taskId: string) {
  const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return rows[0] ?? null;
}

export async function getTaskForUser(db: Db, taskId: string, userId: string) {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------- candidates */

export async function saveCandidates(
  db: Db,
  taskId: string,
  ranked: RankedCandidate[],
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();

  // The unique (task_id, phone_e164) index makes a re-run of discovery
  // idempotent for numbered businesses -- but Postgres treats NULLs as distinct,
  // so candidates without a number matched nothing and a retried research pass
  // duplicated every one of them. They are deduped here on name instead.
  const existing = await db
    .select({ id: businessCandidates.id, name: businessCandidates.name, phoneE164: businessCandidates.phoneE164 })
    .from(businessCandidates)
    .where(eq(businessCandidates.taskId, taskId));
  const byPhone = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const row of existing) {
    if (row.phoneE164) byPhone.set(row.phoneE164, row.id);
    byName.set(row.name.toLowerCase(), row.id);
  }

  for (const entry of ranked) {
    const c = entry.candidate;
    const knownId = c.phoneE164 ? byPhone.get(c.phoneE164) : byName.get(c.name.toLowerCase());
    if (knownId) {
      idMap.set(c.id, knownId);
      continue;
    }
    // The same index still guards the concurrent-insert case.
    const id = newId('cand');
    const inserted = await db
      .insert(businessCandidates)
      .values({
        id,
        taskId,
        name: c.name,
        category: c.category,
        address: c.address,
        latitude: c.latitude,
        longitude: c.longitude,
        phoneE164: c.phoneE164,
        phoneRaw: c.phoneRaw,
        website: c.website,
        source: c.source,
        sourceUrl: c.sourceUrl,
        rating: c.rating,
        reviewCount: c.reviewCount,
        distanceMeters: c.distanceMeters,
        openingHours: c.openingHours,
        phoneVerified: c.phoneVerified,
        score: entry.score,
        rankReasons: entry.reasons,
        excludedReason: entry.excludedReason,
      })
      .onConflictDoNothing()
      .returning({ id: businessCandidates.id });

    if (inserted[0]?.id) {
      if (c.phoneE164) byPhone.set(c.phoneE164, inserted[0].id);
      byName.set(c.name.toLowerCase(), inserted[0].id);
      idMap.set(c.id, inserted[0].id);
    } else {
      // Lost an insert race with another worker; hand back the winner's row
      // rather than an id that does not exist.
      const [winner] = await db
        .select({ id: businessCandidates.id })
        .from(businessCandidates)
        .where(
          and(
            eq(businessCandidates.taskId, taskId),
            c.phoneE164
              ? eq(businessCandidates.phoneE164, c.phoneE164)
              : eq(businessCandidates.name, c.name),
          ),
        )
        .limit(1);
      if (winner) idMap.set(c.id, winner.id);
    }
  }
  return idMap;
}

export async function listCandidates(db: Db, taskId: string): Promise<RankedCandidate[]> {
  const rows = await db
    .select()
    .from(businessCandidates)
    .where(eq(businessCandidates.taskId, taskId))
    .orderBy(desc(businessCandidates.score));

  return rows.map((row) => ({
    candidate: rowToCandidate(row),
    score: row.score,
    reasons: (row.rankReasons as string[]) ?? [],
    excludedReason: row.excludedReason,
  }));
}

export function rowToCandidate(row: typeof businessCandidates.$inferSelect): BusinessCandidate {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    phoneE164: row.phoneE164,
    phoneRaw: row.phoneRaw,
    website: row.website,
    source: row.source as BusinessCandidate['source'],
    sourceUrl: row.sourceUrl,
    rating: row.rating,
    reviewCount: row.reviewCount,
    distanceMeters: row.distanceMeters,
    openingHours: row.openingHours as BusinessCandidate['openingHours'],
    phoneVerified: row.phoneVerified,
    verificationSources: [],
  };
}

export async function markSelected(db: Db, candidateIds: string[]): Promise<void> {
  for (const id of candidateIds) {
    await db
      .update(businessCandidates)
      .set({ selectedForCall: true })
      .where(eq(businessCandidates.id, id));
  }
}

/* ------------------------------------------------------------------ calls */

export async function listCalls(db: Db, taskId: string): Promise<CallRecord[]> {
  const rows = await db.select().from(calls).where(eq(calls.taskId, taskId));
  const out: CallRecord[] = [];
  for (const row of rows) {
    const attempts = await db
      .select()
      .from(callAttempts)
      .where(eq(callAttempts.callId, row.id));
    out.push({
      id: row.id,
      taskId: row.taskId,
      candidateId: row.candidateId,
      businessName: row.businessName,
      // The raw number never leaves the server.
      phoneMasked: maskPhone(row.phoneE164),
      providerCallId: row.providerCallId,
      simulated: row.provider === 'fake',
      providerStatus: row.providerStatus as CallRecord['providerStatus'],
      disposition: row.disposition as CallDisposition,
      structuredResult: row.structuredResult as Record<string, unknown> | null,
      summary: row.summary,
      completionConfidence: row.completionConfidence as CallRecord['completionConfidence'],
      evidence: (row.evidence as string[]) ?? [],
      transcript: attempts.flatMap(
        (a) => (a.transcript as CallRecord['transcript']) ?? [],
      ),
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    });
  }
  return out;
}

export async function findCallByProviderId(db: Db, providerCallId: string) {
  const rows = await db
    .select()
    .from(calls)
    .where(eq(calls.providerCallId, providerCallId))
    .limit(1);
  return rows[0] ?? null;
}

/* --------------------------------------------------------------- settings */

export async function getUserPolicy(db: Db, userId: string): Promise<UserPolicy> {
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const raw = rows[0]?.policy;
  if (!raw) return DEFAULT_USER_POLICY;
  const parsed = userPolicySchema.safeParse(raw);
  // A malformed stored policy falls back to the *restrictive* default rather
  // than to permissiveness.
  return parsed.success ? parsed.data : DEFAULT_USER_POLICY;
}

export async function getSettings(db: Db, userId: string): Promise<UserSettings> {
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const row = rows[0];
  const policy = row?.policy ? userPolicySchema.safeParse(row.policy) : null;

  return {
    policy: policy?.success ? policy.data : DEFAULT_USER_POLICY,
    defaultLocation:
      row?.defaultLatitude != null && row?.defaultLongitude != null
        ? {
            latitude: row.defaultLatitude,
            longitude: row.defaultLongitude,
            label: row.defaultLocationLabel,
          }
        : null,
    preferredLanguage: row?.preferredLanguage ?? 'en',
    callingLanguage: row?.callingLanguage ?? 'en',
    transcriptRetentionDays: row?.transcriptRetentionDays ?? 90,
    notificationsEnabled: row?.notificationsEnabled ?? true,
    askClarifyingQuestions: row?.askClarifyingQuestions ?? true,
  };
}

export async function ensureSettings(db: Db, userId: string): Promise<void> {
  await db
    .insert(userSettings)
    .values({ userId, policy: DEFAULT_USER_POLICY })
    .onConflictDoNothing();
}

/* --------------------------------------------------------------- limits */

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Section 27. Increments and checks the daily call ceiling in one statement so
 * two workers cannot both read "24" and both proceed.
 */
export async function reserveCallBudget(
  db: Db,
  userId: string,
  count: number,
  dailyLimit: number,
): Promise<{ granted: number }> {
  const day = today();
  await db
    .insert(usageCounters)
    .values({ userId, day, callsPlaced: 0 })
    .onConflictDoNothing();

  // The grant is computed inside the statement, from the row's prior value, so
  // two workers cannot both read the same remaining budget and both spend it.
  // Returning `new - old` is the only way to know what was actually granted
  // once the addition has been clamped to the ceiling.
  const result = await db.execute<{ granted: number }>(sql`
    WITH prev AS (
      SELECT calls_placed FROM usage_counters
      WHERE user_id = ${userId} AND day = ${day}
      FOR UPDATE
    )
    UPDATE usage_counters u
    SET calls_placed = LEAST(${dailyLimit}, u.calls_placed + ${count})
    FROM prev
    WHERE u.user_id = ${userId} AND u.day = ${day}
    RETURNING (u.calls_placed - prev.calls_placed) AS granted
  `);

  return { granted: Math.max(0, Number(result.rows?.[0]?.granted ?? 0)) };
}

/**
 * Returns budget to the user's daily counter for calls that were planned but
 * never dialled. Reserved slots that go unused must not spend the ceiling --
 * the limit exists to bound real phones rung, and a number Dial skipped rang
 * nobody.
 */
export async function releaseCallBudget(
  db: Db,
  userId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const day = today();
  await db
    .insert(usageCounters)
    .values({ userId, day, callsPlaced: 0 })
    .onConflictDoNothing();
  await db.execute(sql`
    UPDATE usage_counters
    SET calls_placed = GREATEST(0, calls_placed - ${count})
    WHERE user_id = ${userId} AND day = ${day}
  `);
}

export async function countTasksToday(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.day, today())))
    .limit(1);
  return rows[0]?.tasksCreated ?? 0;
}

/* -------------------------------------------------------------- notifying */

/**
 * Records a notification and schedules its push delivery.
 *
 * The row is the durable record; the job is how it reaches a phone. Delivery
 * rides the same queue as everything else, so an offline push service retries
 * with backoff instead of losing the message, and `push.deliver` is
 * idempotent on the notification's `deliveredAt`.
 */
export async function notify(
  ctx: OrchestratorContext,
  userId: string,
  taskId: string,
  title: string,
  body: string,
): Promise<void> {
  const id = newId('ntf');
  await ctx.db.insert(notifications).values({ id, userId, taskId, title, body });
  await enqueueJob(ctx.db, 'push.deliver', { notificationId: id }, {
    dedupeKey: `push:${id}`,
    maxAttempts: 5,
  });
}

export async function audit(
  db: Db,
  userId: string | null,
  taskId: string | null,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditEvents).values({ id: newId('aud'), userId, taskId, action, detail });
}

/* ---------------------------------------------------------------- mapping */

export function toTaskSummary(row: typeof tasks.$inferSelect): TaskSummary {
  return {
    id: row.id,
    instruction: row.instruction,
    state: row.state as TaskState,
    stateLabel: TASK_STATE_LABELS[row.state as TaskState] ?? row.state,
    headline: row.headline,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function toTaskDetail(db: Db, row: typeof tasks.$inferSelect): Promise<TaskDetail> {
  const [candidates, callRecords, events, pending] = await Promise.all([
    listCandidates(db, row.id),
    listCalls(db, row.id),
    db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, row.id))
      .orderBy(taskEvents.createdAt),
    db
      .select()
      .from(authorizationRequests)
      .where(
        and(eq(authorizationRequests.taskId, row.id), eq(authorizationRequests.state, 'pending')),
      )
      .limit(1),
  ]);

  const auth = pending[0];

  // Whether the number is already kept, so the UI offers to save it only when
  // there is something to save.
  const savedContact = row.directPhone
    ? (
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.userId, row.userId), eq(contacts.phoneE164, row.directPhone)))
          .limit(1)
      ).length > 0
    : false;

  return {
    ...toTaskSummary(row),
    interpreted: (row.interpreted as TaskDetail['interpreted']) ?? null,
    candidates,
    calls: callRecords,
    result: (row.result as TaskDetail['result']) ?? null,
    events: events.map((e) => ({
      id: e.id,
      taskId: e.taskId,
      state: e.state as TaskState,
      message: e.message,
      createdAt: e.createdAt,
    })),
    pendingAuthorization: auth
      ? {
          id: auth.id,
          taskId: auth.taskId,
          kind: auth.kind as never,
          prompt: auth.prompt,
          details: (auth.details as Record<string, unknown>) ?? {},
          state: auth.state as never,
          createdAt: auth.createdAt,
          decidedAt: auth.decidedAt,
        }
      : null,
    directPhone: row.directPhone ?? null,
    directPhoneSaved: savedContact,
    clarificationQuestion: row.clarificationQuestion,
    clarifyingQuestions: (row.clarifyingQuestions as TaskDetail['clarifyingQuestions']) ?? [],
    clarifyingAnswers: (row.clarifyingAnswers as Record<string, string>) ?? {},
  };
}

/** Section 39: retention. Drops transcripts past the user's chosen window. */
export async function purgeExpiredTranscripts(db: Db): Promise<number> {
  const result = await db.execute(sql`
    UPDATE call_attempts SET transcript = '[]'::jsonb
    WHERE transcript <> '[]'::jsonb
      AND call_id IN (
        SELECT c.id FROM calls c
        JOIN tasks t ON t.id = c.task_id
        JOIN user_settings s ON s.user_id = t.user_id
        WHERE s.transcript_retention_days = 0
           OR c.created_at < now() - (s.transcript_retention_days * interval '1 day')
      )
    RETURNING id
  `);
  return (result.rows ?? []).length;
}

export { tasks, calls, businessCandidates, authorizationRequests, users, eq, and, desc, lt };
