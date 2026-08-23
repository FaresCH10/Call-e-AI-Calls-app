import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Phone handling. The rule: a number either normalises to valid E.164 or it is
 * null. Dial never guesses, never patches up a partial number, and never hands
 * CALL-E something it has not validated -- a wrong digit dials a stranger.
 */

export interface NormalizedPhone {
  e164: string;
  country: string | null;
  /** Kept for evidence/display; never used for dialling. */
  raw: string;
}

export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry?: string | null,
): NormalizedPhone | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Directory data frequently carries several numbers in one field
  // ("+353 1 234 5678; +353 87 999 0000"). Take the first that validates.
  const parts = trimmed.split(/[;,/]| or /i).map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    const parsed = parsePhoneNumberFromString(
      part,
      defaultCountry ? (defaultCountry.toUpperCase() as CountryCode) : undefined,
    );
    if (parsed && parsed.isValid()) {
      return { e164: parsed.number, country: parsed.country ?? null, raw: part };
    }
  }
  return null;
}

export function isValidE164(value: string | null | undefined): boolean {
  if (!value) return false;
  if (!/^\+[1-9]\d{6,14}$/.test(value)) return false;
  const parsed = parsePhoneNumberFromString(value);
  return Boolean(parsed?.isValid());
}

export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 4) return '***';
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

/**
 * Premium-rate, and non-routable test ranges. Dial refuses to dial these: the
 * first bills the user by the minute, the second is reserved for fiction.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /^\+1900\d+$/, // US premium
  /^\+1976\d+$/,
  /^\+44(9|87)\d+$/, // UK premium / revenue share
  /^\+1\d{3}555(01\d{2})$/, // NANP fictional range
];

export function isBlockedNumber(e164: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(e164));
}

/**
 * Two directory entries for the same shop are common (one from the map, one
 * from a listing). Same E.164 means same business for calling purposes.
 */
export function dedupeByPhone<T extends { phoneE164: string | null }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item.phoneE164) continue;
    if (seen.has(item.phoneE164)) continue;
    seen.add(item.phoneE164);
    out.push(item);
  }
  return out;
}

/** Normalises a business name for duplicate detection across sources. */
export function businessNameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(ltd|limited|inc|llc|plc|gmbh|co|company|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}
