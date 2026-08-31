import { z } from 'zod';
import { dialTaskSchema, TASK_STATES, clarifyingQuestionSchema } from './task.js';
import { rankedCandidateSchema } from './candidate.js';
import { callRecordSchema, taskResultSchema } from './results.js';
import { userPolicySchema, authorizationKindSchema, AUTHORIZATION_DECISIONS } from './authorization.js';

/** Wire contracts shared verbatim by apps/api, apps/web and apps/mobile. */

/* ------------------------------------------------------------------- auth */

export const signUpRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(200),
  name: z.string().min(1).max(120),
});
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

export const signInRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const authResponseSchema = z.object({
  user: sessionUserSchema,
  /** Bearer token for native clients. Web uses an httpOnly cookie instead. */
  token: z.string().nullable(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

/* ------------------------------------------------------------------ tasks */

export const locationInputSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  /** Free text the user typed, e.g. "Dublin 2". Geocoded server-side. */
  text: z.string().max(200).nullable().default(null),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export const createTaskRequestSchema = z.object({
  instruction: z.string().min(3).max(2000),
  location: locationInputSchema.nullable().default(null),
  /** Client-generated, so a double-tap or a retry cannot create two tasks. */
  idempotencyKey: z.string().min(8).max(200),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const taskEventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /** Machine state at the time. */
  state: z.enum(TASK_STATES),
  /** Already-translated user-facing line, e.g. "Calling 2 of 4". */
  message: z.string(),
  createdAt: z.string(),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const authorizationRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: authorizationKindSchema,
  /** Plain-language question shown to the user. */
  prompt: z.string(),
  /** What specifically Dial wants permission to do. */
  details: z.record(z.string(), z.unknown()).default({}),
  state: z.enum(AUTHORIZATION_DECISIONS),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type AuthorizationRequestDto = z.infer<typeof authorizationRequestSchema>;

export const taskSummarySchema = z.object({
  id: z.string(),
  instruction: z.string(),
  state: z.enum(TASK_STATES),
  stateLabel: z.string(),
  headline: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskDetailSchema = taskSummarySchema.extend({
  interpreted: dialTaskSchema.nullable(),
  candidates: z.array(rankedCandidateSchema).default([]),
  calls: z.array(callRecordSchema).default([]),
  result: taskResultSchema.nullable(),
  events: z.array(taskEventSchema).default([]),
  pendingAuthorization: authorizationRequestSchema.nullable(),
  /**
   * The number the user named in the request, when they named one. Present
   * means Dial searched for nothing, and the UI can offer to keep it.
   */
  directPhone: z.string().nullable().default(null),
  /** True when that number is already in the user's contacts. */
  directPhoneSaved: z.boolean().default(false),
  /** Set when state is needs_user_input. */
  clarificationQuestion: z.string().nullable(),
  /** Intake questions awaiting answers, if any. */
  clarifyingQuestions: z.array(clarifyingQuestionSchema).default([]),
  /** What the user already answered, keyed by question id. */
  clarifyingAnswers: z.record(z.string(), z.string()).default({}),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const answerClarificationRequestSchema = z.object({
  answer: z.string().min(1).max(1000),
});

/** Answers to the intake questions. Any subset; blanks mean "no preference". */
export const answerQuestionsRequestSchema = z.object({
  answers: z
    .array(z.object({ id: z.string().min(1).max(60), answer: z.string().max(500) }))
    .max(10)
    .default([]),
  /** True when the user chose to get on with it instead of answering. */
  skipped: z.boolean().default(false),
});

/**
 * Asks Dial to ring a business back and do something -- make the appointment,
 * place the order, whatever the user says. The instruction is theirs, not a
 * suggestion Dial generated, so there is nothing to fabricate.
 */
export const actOnBusinessRequestSchema = z.object({
  candidateId: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(3).max(500),
});

/** Calls one business the user picked out of the list Dial found. */
export const callCandidateRequestSchema = z.object({
  candidateId: z.string().trim().min(1).max(80),
});

export const authorizationDecisionRequestSchema = z.object({
  approved: z.boolean(),
});

export const taskListResponseSchema = z.object({
  tasks: z.array(taskSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

/* --------------------------------------------------------------- contacts */

/**
 * A number the user chose to keep.
 *
 * The number is shown in full rather than masked: the user typed it, saved it,
 * and needs to recognise it. Masking here would protect them from their own
 * address book.
 */
export const contactSchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string(),
  createdAt: z.string(),
});
export type Contact = z.infer<typeof contactSchema>;

export const contactListResponseSchema = z.object({
  contacts: z.array(contactSchema),
});

/**
 * Saves a number. Either the number itself, or the task whose number to keep --
 * the latter so a raw number never has to travel back to the client and in
 * again just to be stored.
 */
export const createContactRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().min(3).max(30).optional(),
    taskId: z.string().trim().min(1).max(64).optional(),
  })
  .refine((v) => Boolean(v.phone) !== Boolean(v.taskId), {
    message: 'Give either a phone number or a task, not both.',
  });

export const renameContactRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

/**
 * Bulk contact import from a device address book. Entries arrive raw; the
 * server normalizes, validates and skips what it cannot dial, so the client
 * never has to agree with the server about what a valid number is.
 */
export const contactImportEntrySchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(3).max(30),
});
export type ContactImportEntry = z.infer<typeof contactImportEntrySchema>;

export const importContactsRequestSchema = z.object({
  contacts: z.array(contactImportEntrySchema).min(1).max(200),
});

export const importContactsResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
  renamed: z.number().int().nonnegative(),
  skipped: z.array(
    z.object({ name: z.string(), reason: z.enum(['invalid_number', 'blocked_number']) }),
  ),
});
export type ImportContactsResponse = z.infer<typeof importContactsResponseSchema>;

/* ------------------------------------------------------------------- push */

/** Registers a device for push notifications. The token is Expo's push token. */
export const pushRegisterRequestSchema = z.object({
  token: z.string().trim().min(10).max(500),
  platform: z.enum(['ios', 'android']),
});

export const pushUnregisterRequestSchema = z.object({
  token: z.string().trim().min(10).max(500),
});

/* --------------------------------------------------------------- settings */

export const userSettingsSchema = z.object({
  policy: userPolicySchema,
  defaultLocation: z
    .object({
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      label: z.string().nullable(),
    })
    .nullable(),
  preferredLanguage: z.string().max(20).default('en'),
  callingLanguage: z.string().max(20).default('en'),
  /** Days to keep transcripts. 0 means "do not store transcripts at all". */
  transcriptRetentionDays: z.number().int().min(0).max(3650).default(90),
  notificationsEnabled: z.boolean().default(true),
  /**
   * Ask a few questions before starting. On by default because the answers
   * measurably improve who gets called and what they get asked; a user who
   * wants Dial to just go can turn it off.
   */
  askClarifyingQuestions: z.boolean().default(true),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const updateSettingsRequestSchema = userSettingsSchema.partial();

/**
 * What the account has actually used, and against what ceiling.
 *
 * The counts come from the same `usage_counters` rows the call budget is
 * enforced against, so the page cannot show one number while the limiter
 * applies another.
 */
export const usageDaySchema = z.object({
  /** YYYY-MM-DD, UTC. */
  day: z.string(),
  callsPlaced: z.number().int(),
  tasksCreated: z.number().int(),
});

export const usageResponseSchema = z.object({
  today: usageDaySchema,
  history: z.array(usageDaySchema),
  totals: z.object({ callsPlaced: z.number().int(), tasksCreated: z.number().int() }),
  limits: z.object({
    /** Calls this account may place in a UTC day. */
    callsPerDay: z.number().int(),
    /** Calls one task may place before Dial stops and reports what it has. */
    callsPerTask: z.number().int(),
  }),
});
export type UsageResponse = z.infer<typeof usageResponseSchema>;

/* ----------------------------------------------------------------- system */

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  callMode: z.enum(['mock', 'real']),
  /** Which integrations are actually configured. Surfaced so nothing is ambiguous. */
  integrations: z.object({
    calle: z.boolean(),
    llm: z.boolean(),
    discovery: z.string(),
    queue: z.string(),
    database: z.string(),
    push: z.boolean().default(false),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
