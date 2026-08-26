import { eq } from 'drizzle-orm';
import { processedWebhookEvents, calls } from '@dial/database';
import { calleWebhookEventSchema, type CalleWebhookEvent } from '@dial/schemas';
import { logger, incrementCounter } from '@dial/observability';
import type { OrchestratorContext } from './context.js';
import { applyTerminalSnapshot, maybeAdvance } from './pipeline.js';

/**
 * Section 6. The webhook boundary.
 *
 * CALL-E's deliveries are NOT signed -- the SDK's `webhooks.verify()` is marked
 * @deprecated for exactly that reason. So a delivery is treated as an untrusted
 * *hint* that something finished, never as the result itself:
 *
 *   1. Validate the payload's structure.
 *   2. Require the CALL-E-Event-Id header to match the body id.
 *   3. Check the call is one Dial actually placed -- before writing anything,
 *      so unauthenticated traffic cannot grow the event table.
 *   4. Record the event id; a replay is then a no-op by construction.
 *   5. Re-fetch the call from CALL-E with our own API key, and persist THAT.
 *
 * Step 4 is the important one: anyone can POST this endpoint, so nothing a
 * caller sends is ever written to a call record.
 */

export type WebhookOutcome =
  | { status: 'accepted'; callId: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string }
  | { status: 'rejected'; reason: string };

export async function handleCalleWebhook(
  ctx: OrchestratorContext,
  rawBody: unknown,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookOutcome> {
  const parsed = calleWebhookEventSchema.safeParse(rawBody);
  if (!parsed.success) {
    incrementCounter('webhook.rejected', { reason: 'malformed' });
    return { status: 'rejected', reason: 'Malformed webhook payload.' };
  }
  const event: CalleWebhookEvent = parsed.data;

  // Node lowercases every incoming header name; match case-insensitively so
  // the check survives whatever reverse proxy sits in front.
  const headerEntry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === 'call-e-event-id',
  );
  const headerIdRaw = headerEntry?.[1];
  const headerId = Array.isArray(headerIdRaw) ? headerIdRaw[0] : headerIdRaw;
  if (!headerId || headerId !== event.id) {
    // The documented mitigation for unsigned deliveries.
    incrementCounter('webhook.rejected', { reason: 'event_id_mismatch' });
    return { status: 'rejected', reason: 'Event id header did not match the payload.' };
  }

  // Ownership before claiming. The endpoint is unauthenticated, and claiming
  // first let anyone with a well-shaped payload grow processed_webhook_events
  // without bound -- rows for calls Dial does not own are worth nothing, so
  // they are refused before anything is written.
  const owned = await ctx.db
    .select({ id: calls.id, taskId: calls.taskId })
    .from(calls)
    .where(eq(calls.providerCallId, event.data.id))
    .limit(1);
  const call = owned[0];
  if (!call) {
    // A call we do not own, or one from another environment sharing the key.
    incrementCounter('webhook.ignored', { reason: 'unknown_call' });
    return { status: 'ignored', reason: 'No matching call.' };
  }

  // Claim the event id before doing any work. At-least-once delivery means
  // duplicates are normal; the primary key makes the second one a no-op.
  const claimed = await ctx.db
    .insert(processedWebhookEvents)
    .values({
      eventId: event.id,
      eventType: event.type,
      providerCallId: event.data.id,
    })
    .onConflictDoNothing()
    .returning({ eventId: processedWebhookEvents.eventId });

  if (claimed.length === 0) {
    incrementCounter('webhook.duplicate');
    return { status: 'duplicate' };
  }

  // Never trust the delivered body: ask CALL-E directly, authenticated.
  const snapshot = await ctx.provider.get(event.data.id);
  await applyTerminalSnapshot(ctx, call.taskId, call.id, snapshot);
  await maybeAdvance(ctx, call.taskId);

  incrementCounter('webhook.accepted', { type: event.type });
  logger.info('webhook applied', { callId: call.id, providerRequestId: event.data.id });
  return { status: 'accepted', callId: call.id };
}
