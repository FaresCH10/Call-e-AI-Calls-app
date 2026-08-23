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

export const authorizationDecisionRequestSchema = z.object({
  approved: z.boolean(),
});

export const taskListResponseSchema = z.object({
  tasks: z.array(taskSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

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
