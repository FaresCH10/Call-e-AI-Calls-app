import { z } from 'zod';
import { businessCandidateSchema } from './candidate.js';
import { transcriptTurnSchema, completionConfidenceSchema, CALLE_CALL_STATUSES } from './calle.js';

/**
 * How a call ended, in Dial's vocabulary. Kept separate from CALL-E's own
 * `status` so our judgement is never mistaken for the provider's.
 */
export const CALL_DISPOSITIONS = [
  'pending',
  'answered_useful',
  'answered_no_answer_to_question',
  'refused',
  'no_answer',
  'voicemail',
  'failed',
  'needs_review',
  /** Planned, but Dial had enough answers before reaching it. Never dialled. */
  'not_needed',
] as const;
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export const CALL_DISPOSITION_LABELS: Record<CallDisposition, string> = {
  pending: 'In progress',
  answered_useful: 'Answered',
  answered_no_answer_to_question: "Answered, couldn't say",
  refused: 'Declined to answer',
  no_answer: 'No answer',
  voicemail: 'Voicemail',
  failed: "Couldn't connect",
  needs_review: 'Needs review',
  not_needed: 'Not needed',
};

/** One call Dial placed, with everything needed to justify the outcome. */
export const callRecordSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  candidateId: z.string(),
  businessName: z.string(),
  /** Masked for transport. The raw number never leaves the server. */
  phoneMasked: z.string().nullable(),
  providerCallId: z.string().nullable(),
  /**
   * True when this call was simulated rather than dialled. Surfaced so the UI
   * can never present a simulated outcome as a real one (section 31).
   */
  simulated: z.boolean().default(false),
  providerStatus: z.enum(CALLE_CALL_STATUSES).nullable(),
  disposition: z.enum(CALL_DISPOSITIONS),
  structuredResult: z.record(z.string(), z.unknown()).nullable(),
  summary: z.string().nullable(),
  completionConfidence: completionConfidenceSchema.nullable(),
  evidence: z.array(z.string()).default([]),
  transcript: z.array(transcriptTurnSchema).default([]),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type CallRecord = z.infer<typeof callRecordSchema>;

/** A comparable, normalised outcome derived from one call. */
export const comparableOutcomeSchema = z.object({
  callId: z.string(),
  candidate: businessCandidateSchema,
  /** Price normalised to a single currency for ranking; null when not comparable. */
  normalizedPrice: z.number().nullable(),
  normalizedCurrency: z.string().nullable(),
  /** The price as actually quoted, before normalisation. */
  quotedPrice: z.number().nullable(),
  quotedCurrency: z.string().nullable(),
  /** Explains any adjustment, e.g. "callout fee added". */
  normalizationNotes: z.array(z.string()).default([]),
  viable: z.boolean(),
  highlights: z.array(z.string()).default([]),
  conditions: z.array(z.string()).default([]),
  rank: z.number().int().nullable(),
  rankReasons: z.array(z.string()).default([]),
  structuredResult: z.record(z.string(), z.unknown()).nullable(),
  disposition: z.enum(CALL_DISPOSITIONS),
});
export type ComparableOutcome = z.infer<typeof comparableOutcomeSchema>;

/**
 * The honest tally behind every claim Dial makes. Section 15: we say "lowest
 * verified quote among the N we contacted", never "cheapest in the city".
 */
export const evidenceTallySchema = z.object({
  discovered: z.number().int().nonnegative(),
  contacted: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(),
  comparable: z.number().int().nonnegative(),
  verifiedAt: z.string().nullable(),
});
export type EvidenceTally = z.infer<typeof evidenceTallySchema>;

export const taskResultSchema = z.object({
  /** One sentence, already hedged correctly for the evidence available. */
  headline: z.string(),
  /** Null when nothing verifiable was established. */
  best: comparableOutcomeSchema.nullable(),
  alternatives: z.array(comparableOutcomeSchema).default([]),
  /** Outcomes that could not be compared, kept visible rather than hidden. */
  unusable: z.array(comparableOutcomeSchema).default([]),
  tally: evidenceTallySchema,
  /** Anything Dial could not establish, stated plainly. */
  caveats: z.array(z.string()).default([]),
});
export type TaskResult = z.infer<typeof taskResultSchema>;
