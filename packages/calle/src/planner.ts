import type { BusinessCandidate, CallFamily, DialTask, UserPolicy } from '@dial/schemas';
import { sanitizeExternalText } from '@dial/domain';

/**
 * Section 12. Turns a normalised task into the brief CALL-E's agent works from.
 *
 * The brief states goals and boundaries, not a word-for-word script -- CALL-E
 * holds the conversation, and a rigid script would fall apart the moment the
 * person on the other end says something unexpected. What it does pin down is
 * everything with a real-world consequence: what may be agreed to, what may not,
 * what may be disclosed, and what to do when the answer is not available.
 */

export interface CallPlanInput {
  task: DialTask;
  family: CallFamily;
  candidate: BusinessCandidate;
  policy: UserPolicy;
  /** Whether this call is authorised to actually commit the user. */
  mayCommit: boolean;
  /** Facts the user has explicitly supplied for this task. */
  userFacts: Record<string, string>;
  userDisplayName: string | null;
}

export function buildCallBrief(input: CallPlanInput): string {
  const { task, family, candidate, policy, mayCommit, userFacts, userDisplayName } = input;

  const lines: string[] = [];

  lines.push(
    `You are an AI assistant placing a phone call on behalf of a customer. Be brief, polite and natural.`,
  );

  // Section 18: disclosure. Stated first because it must happen first.
  lines.push(
    `Identify yourself as an AI assistant calling on behalf of a customer at the start of the call. Never claim to be a human, and never claim to be the customer.`,
  );

  lines.push(``, `WHO YOU ARE CALLING`);
  lines.push(`${sanitizeExternalText(candidate.name, 120)}${candidate.category ? `, a ${candidate.category.replace(/_/g, ' ')}` : ''}.`);

  lines.push(``, `WHY`);
  lines.push(sanitizeExternalText(task.objective, 400));

  lines.push(``, `WHAT YOU MUST FIND OUT`);
  for (const question of questionsFor(family, task)) lines.push(`- ${question}`);

  const known = knownFacts(task, userFacts, userDisplayName);
  if (known.length) {
    lines.push(``, `WHAT YOU ALREADY KNOW (state these if asked; do not ask the business for them)`);
    for (const fact of known) lines.push(`- ${fact}`);
  }

  const constraints = constraintLines(task);
  if (constraints.length) {
    lines.push(``, `THE CUSTOMER'S REQUIREMENTS`);
    for (const line of constraints) lines.push(`- ${line}`);
  }

  lines.push(``, `WHAT COUNTS AS SUCCESS`);
  lines.push(sanitizeExternalText(task.successCondition, 300));

  lines.push(``, `WHAT YOU MAY AGREE TO`);
  if (mayCommit && task.requestedSideEffect === 'reservation') {
    lines.push(
      `- You may make a reservation on the customer's behalf, but only matching the requirements above.`,
    );
    lines.push(`- Get a confirmation name or reference before ending the call.`);
  } else if (mayCommit && task.requestedSideEffect === 'appointment') {
    lines.push(`- You may book an appointment matching the requirements above.`);
    lines.push(`- Confirm the date, time and anything the customer must bring.`);
  } else {
    lines.push(`- Nothing. This call is to gather information only.`);
    lines.push(
      `- Do NOT book, reserve, order, hold, or agree to anything. If they offer to book you in, say you will confirm separately.`,
    );
  }

  lines.push(``, `WHAT YOU MUST NOT DO`);
  lines.push(`- Do not agree to any payment, deposit, or card details.`);
  lines.push(`- Do not accept a price above what the customer asked for without saying you must check first.`);
  lines.push(`- Do not give out any personal detail that is not listed above as known.`);
  lines.push(`- Do not invent an answer. If they will not say, record that they would not say.`);
  lines.push(`- Do not argue, pressure, or call back repeatedly.`);

  // Section 17: identity facts are never fabricated.
  lines.push(
    `- If they ask for a detail you were not given (date of birth, an account number, a reference), say you do not have it and that the customer will follow up directly. Never guess or make one up.`,
  );

  if (policy.leaveVoicemail === 'never') {
    lines.push(`- Do not leave a voicemail. If you reach an answering machine, end the call.`);
  } else if (policy.leaveVoicemail === 'allow') {
    lines.push(
      `- If you reach voicemail, you may leave a short message saying a customer is enquiring, and end the call.`,
    );
  } else {
    lines.push(`- If you reach voicemail, end the call without leaving a message.`);
  }

  lines.push(``, `IF THEY ASK SOMETHING UNEXPECTED`);
  lines.push(
    `Answer only from what you know above. If you cannot, say plainly that you will pass the question back to the customer. It is always better to return "unknown" than to guess.`,
  );

  lines.push(``, `RECORDING THE ANSWER`);
  lines.push(
    `Fill in the structured result honestly. Use "unknown" wherever the business did not clearly answer. Do not turn a vague or non-committal reply into a definite yes or a firm price.`,
  );

  return lines.join('\n');
}

function questionsFor(family: CallFamily, task: DialTask): string[] {
  const extras = task.constraints.additional;
  const device = typeof extras['device'] === 'string' ? extras['device'] : null;
  const issue = typeof extras['issue'] === 'string' ? extras['issue'] : null;

  switch (family.id) {
    case 'repair_quote':
      return [
        `Whether they can repair ${device ?? 'the customer’s device'}${issue ? ` (${issue})` : ''}.`,
        'The total price, and whether that price includes tax.',
        'Whether the parts are original, original-equivalent, or aftermarket.',
        'How long the repair takes, and whether it can be done today.',
        'What warranty is offered.',
        'Whether an appointment is needed.',
      ];
    case 'service_quote':
      return [
        'Whether they can do this job.',
        'The estimated price for the work.',
        'Any separate callout or travel fee.',
        'Whether parts are included in that figure.',
        'The earliest they could attend.',
        'Whether the figure is a fixed price or an estimate.',
      ];
    case 'reservation':
      return [
        `Whether they have a table for ${task.constraints.partySize ?? 'the party'}${task.constraints.date ? ` on ${task.constraints.date}` : ''}${task.constraints.timeWindow?.earliest ? ` around ${task.constraints.timeWindow.earliest}` : ''}.`,
        'If not, what nearby times they do have.',
        'Any conditions (deposit, time limit on the table, dress code).',
      ];
    case 'appointment':
      return [
        'Whether they have an appointment available in the requested window.',
        'The earliest date and time available.',
        'The likely cost.',
        'Anything the customer needs to bring or do beforehand.',
      ];
    case 'availability_check':
      return [
        'Whether the thing the customer asked about is available.',
        'The price, if relevant.',
        'When it will be available if it is not right now.',
      ];
    case 'status_check':
      return [
        'The status of the item the customer asked about.',
        'If they will not say, why not, and what the customer should do instead.',
        'Whether it is ready to collect, and the collection hours.',
      ];
    default:
      return [sanitizeExternalText(task.objective, 200)];
  }
}

function constraintLines(task: DialTask): string[] {
  const out: string[] = [];
  const c = task.constraints;

  if (c.budget) {
    const word = c.budget.comparator === 'max' ? 'no more than' : c.budget.comparator === 'min' ? 'at least' : 'around';
    out.push(`Budget: ${word} ${c.budget.currency} ${c.budget.amount}.`);
  }
  if (c.date) out.push(`Date: ${c.date}.`);
  if (c.timeWindow?.earliest) {
    const flex = c.timeWindow.flexibilityMinutes;
    out.push(
      `Time: around ${c.timeWindow.earliest}${c.timeWindow.latest ? ` to ${c.timeWindow.latest}` : ''}` +
        (flex > 0
          ? `. You may accept up to ${flex} minutes either side, but nothing outside that.`
          : `. Do not accept a different time.`),
    );
  }
  if (c.partySize) out.push(`Party size: ${c.partySize}.`);
  for (const [key, value] of Object.entries(c.additional)) {
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(`${key.replace(/_/g, ' ')}: ${sanitizeExternalText(String(value), 120)}.`);
    }
  }
  return out;
}

function knownFacts(
  task: DialTask,
  userFacts: Record<string, string>,
  userDisplayName: string | null,
): string[] {
  const out: string[] = [];
  if (userDisplayName) out.push(`The customer's name is ${sanitizeExternalText(userDisplayName, 80)}.`);
  for (const [key, value] of Object.entries(userFacts)) {
    out.push(`${key.replace(/_/g, ' ')}: ${sanitizeExternalText(value, 160)}.`);
  }
  if (task.constraints.additional['device']) {
    out.push(`Device: ${sanitizeExternalText(String(task.constraints.additional['device']), 80)}.`);
  }
  return out;
}
