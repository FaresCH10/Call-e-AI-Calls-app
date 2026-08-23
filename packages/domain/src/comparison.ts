import type {
  CallRecord,
  BusinessCandidate,
  ComparableOutcome,
  TaskResult,
  EvidenceTally,
  CallFamily,
  DialTask,
  CallDisposition,
} from '@dial/schemas';

/**
 * Section 15 / section 16. Turns raw call outcomes into a ranked, *defensible*
 * answer.
 *
 * The whole module is built around one rule: a claim may only be as strong as
 * the evidence collected. "Cheapest in the city" is never sayable. "Lowest
 * verified quote among the 4 that answered" is, and only when 4 answered.
 */

export interface ComparisonInput {
  task: Pick<DialTask, 'taskFamily' | 'constraints' | 'objective'>;
  family: CallFamily;
  calls: CallRecord[];
  candidatesById: Map<string, BusinessCandidate>;
  discoveredCount: number;
}

const YES = 'yes';

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A disposition that means the business actually gave us usable information. */
function isUsable(disposition: CallDisposition): boolean {
  return disposition === 'answered_useful';
}

function buildOutcome(
  call: CallRecord,
  candidate: BusinessCandidate,
  family: CallFamily,
): ComparableOutcome {
  const result = call.structuredResult;
  const notes: string[] = [];
  const highlights: string[] = [];
  const conditions: string[] = [];

  let quotedPrice: number | null = null;
  let quotedCurrency: string | null = null;
  let normalizedPrice: number | null = null;

  if (result && family.priceField) {
    quotedPrice = num(result[family.priceField]);
    quotedCurrency = str(result['currency']);
    if (quotedPrice !== null && quotedPrice > 0) {
      normalizedPrice = quotedPrice;
      // A callout fee is money the user pays, so it belongs in the comparison.
      // Leaving it out would make the cheapest-looking option the wrong answer.
      const callout = num(result['callout_fee']);
      if (callout !== null && callout > 0) {
        normalizedPrice += callout;
        notes.push(`Includes ${quotedCurrency ?? ''} ${callout.toFixed(2)} callout fee`.trim());
      }
      if (result['price_includes_tax'] === 'no') {
        notes.push('Quote excludes tax');
      } else if (result['price_includes_tax'] === 'unknown') {
        notes.push('Unclear whether tax is included');
      }
      if (result['parts_included'] === 'no') notes.push('Parts not included');
    } else {
      quotedPrice = null;
    }
  }

  // Viability: did they say they can actually do the thing?
  let viable = false;
  if (result && family.viabilityField) {
    const v = result[family.viabilityField];
    viable = v === YES || v === 'available' || v === 'alternative_offered';
  }
  if (!isUsable(call.disposition)) viable = false;

  if (result) {
    if (result['same_day_available'] === YES) highlights.push('Same day');
    if (str(result['turnaround'])) highlights.push(String(result['turnaround']));
    if (str(result['warranty'])) highlights.push(String(result['warranty']));
    if (str(result['earliest_arrival'])) highlights.push(`Earliest: ${result['earliest_arrival']}`);
    if (result['parts_quality'] && result['parts_quality'] !== 'unknown') {
      highlights.push(String(result['parts_quality']).replace(/_/g, ' '));
    }
    if (str(result['time'])) highlights.push(String(result['time']));
    if (result['quote_binding'] === 'estimate') conditions.push('Estimate, not a fixed price');
    if (result['appointment_required'] === YES) conditions.push('Appointment required');
    for (const key of ['quote_conditions', 'additional_conditions', 'special_conditions', 'conditions']) {
      const c = str(result[key]);
      if (c) conditions.push(c);
    }
  }

  if (candidate.distanceMeters !== null) {
    highlights.push(`${(candidate.distanceMeters / 1000).toFixed(1)} km away`);
  }

  // Two fields can legitimately carry the same phrase ("within 24 hours" as both
  // turnaround and warranty, say). Showing it twice looks like a rendering bug,
  // so collapse duplicates while preserving order.
  const dedupe = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

  return {
    callId: call.id,
    candidate,
    normalizedPrice,
    normalizedCurrency: quotedCurrency,
    quotedPrice,
    quotedCurrency,
    normalizationNotes: notes,
    viable,
    highlights: dedupe(highlights),
    conditions: dedupe(conditions),
    rank: null,
    rankReasons: [],
    structuredResult: result,
    disposition: call.disposition,
  };
}

/**
 * Currencies are never converted. Without a rate source we would be inventing a
 * number and then ranking on it -- exactly the fabrication section 41 forbids.
 * Instead we compare within the majority currency and say so in the caveats.
 */
function dominantCurrency(outcomes: ComparableOutcome[]): string | null {
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    if (o.normalizedPrice !== null && o.normalizedCurrency) {
      counts.set(o.normalizedCurrency, (counts.get(o.normalizedCurrency) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

export function compareOutcomes(input: ComparisonInput): TaskResult {
  const { calls, candidatesById, family, task, discoveredCount } = input;

  const outcomes: ComparableOutcome[] = [];
  for (const call of calls) {
    const candidate = candidatesById.get(call.candidateId);
    if (!candidate) continue;
    outcomes.push(buildOutcome(call, candidate, family));
  }

  // Only calls that were actually dispatched count as contacted. A planned row
  // that never got dialled must not inflate "we contacted N businesses" -- the
  // whole point of the tally is that every number in it is defensible.
  const contacted = calls.filter((c) => c.providerCallId !== null);
  const answered = contacted.filter((c) =>
    ['answered_useful', 'answered_no_answer_to_question', 'refused'].includes(c.disposition),
  ).length;

  const usable = outcomes.filter((o) => o.viable);
  const unusable = outcomes.filter((o) => !o.viable);

  const caveats: string[] = [];
  const currency = dominantCurrency(usable);

  // Budget filter, applied only where a real comparable price exists.
  const budget = task.constraints.budget;
  let inBudget = usable;
  if (budget && currency) {
    if (budget.currency !== currency) {
      caveats.push(
        `Your budget is in ${budget.currency} but quotes came back in ${currency}. Dial has not converted between them.`,
      );
    } else {
      const matching = usable.filter(
        (o) =>
          o.normalizedPrice === null ||
          (budget.comparator === 'max'
            ? o.normalizedPrice <= budget.amount
            : budget.comparator === 'min'
              ? o.normalizedPrice >= budget.amount
              : true),
      );
      if (matching.length === 0 && usable.length > 0) {
        caveats.push(
          `No business Dial contacted confirmed a price ${budget.comparator === 'max' ? 'under' : 'over'} ${budget.currency} ${budget.amount}.`,
        );
      } else {
        inBudget = matching;
      }
    }
  }

  const mixedCurrency = new Set(
    usable.map((o) => o.normalizedCurrency).filter((c): c is string => Boolean(c)),
  ).size > 1;
  if (mixedCurrency) {
    caveats.push('Quotes came back in more than one currency and were not converted.');
  }

  // Rank: priced options first, cheapest comparable price wins; then
  // same-day/availability, then distance. Ties fall back to rating.
  const priced = inBudget.filter(
    (o) => o.normalizedPrice !== null && (!currency || o.normalizedCurrency === currency),
  );
  const unpriced = inBudget.filter((o) => !priced.includes(o));

  priced.sort((a, b) => (a.normalizedPrice ?? 0) - (b.normalizedPrice ?? 0));
  unpriced.sort(
    (a, b) => (a.candidate.distanceMeters ?? 1e9) - (b.candidate.distanceMeters ?? 1e9),
  );

  const ordered = family.priceField ? [...priced, ...unpriced] : [...unpriced, ...priced];

  ordered.forEach((outcome, index) => {
    outcome.rank = index + 1;
    const reasons: string[] = [];
    if (outcome.normalizedPrice !== null) {
      reasons.push(
        `${outcome.normalizedCurrency ?? ''} ${outcome.normalizedPrice.toFixed(2)} verified price`.trim(),
      );
    }
    for (const h of outcome.highlights.slice(0, 3)) reasons.push(h);
    outcome.rankReasons = reasons;
  });

  const best = ordered[0] ?? null;
  const tally: EvidenceTally = {
    discovered: discoveredCount,
    contacted: contacted.length,
    answered,
    comparable: ordered.length,
    verifiedAt: best ? (calls.find((c) => c.id === best.callId)?.completedAt ?? null) : null,
  };

  return {
    headline: buildHeadline(best, tally, family),
    best,
    alternatives: ordered.slice(1),
    unusable,
    tally,
    caveats,
  };
}

/**
 * The sentence the user reads first. It is generated from the tally, not from a
 * model, so it cannot overstate what was actually established.
 */
export function buildHeadline(
  best: ComparableOutcome | null,
  tally: EvidenceTally,
  family: CallFamily,
): string {
  if (tally.contacted === 0) {
    return 'Dial did not manage to contact any business for this request.';
  }
  if (!best) {
    if (tally.answered === 0) {
      return `Dial called ${tally.contacted} ${plural(tally.contacted, 'business', 'businesses')}, but none answered.`;
    }
    return `Dial spoke to ${tally.answered} of ${tally.contacted} ${plural(tally.contacted, 'business', 'businesses')}, but none could confirm what you asked for.`;
  }

  const name = best.candidate.name;

  if (best.normalizedPrice !== null && family.priceField) {
    const price = `${best.normalizedCurrency ?? ''} ${best.normalizedPrice.toFixed(2)}`.trim();
    return `Lowest verified quote among the ${tally.comparable} ${plural(tally.comparable, 'business', 'businesses')} that gave Dial a comparable price: ${name} at ${price}.`;
  }

  const bookingMade = best.structuredResult?.['booking_made'] === YES;
  if (bookingMade) {
    const code = best.structuredResult?.['confirmation_code'];
    return `Confirmed with ${name}${code ? ` — confirmation ${String(code)}` : ''}.`;
  }

  return `Best verified option among the ${tally.answered} ${plural(tally.answered, 'business', 'businesses')} that answered: ${name}.`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
