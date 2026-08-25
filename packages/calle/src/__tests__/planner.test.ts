import { describe, it, expect } from 'vitest';
import { getCallFamily, DEFAULT_USER_POLICY, type DialTask } from '@dial/schemas';
import { buildCallBrief } from '../planner.js';

/**
 * The brief is the only thing standing between Dial and a bad phone call.
 *
 * These pin the parts that were learned the hard way. One real call ran to
 * fifteen exchanges against a recorded message: the recording said, three ways,
 * that the restaurant could not help by phone and to use the website, and Dial
 * rephrased the same question each time, said "I'll hold", and asked again --
 * for minutes, at the customer's expense, against a machine.
 *
 * Nothing in the brief was wrong. There was simply nothing in it about when to
 * stop, and "do not argue or call back repeatedly" reads as advice about manner
 * rather than as a stop condition.
 */

const TASK: DialTask = {
  objective: 'Find the price of a burger',
  taskFamily: 'quote_request',
  domain: 'restaurant',
  searchQuery: 'burger restaurant',
  calleeName: null,
  callPurpose: null,
  location: { raw: 'London', latitude: null, longitude: null, label: null, radiusKm: 10 },
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
  successCondition: 'A burger price is obtained',
  requestedSideEffect: 'information_only',
  sensitivity: 'normal',
  authorizationRequirement: 'none',
  clarificationNeeded: null,
  isEmergency: false,
};

function brief(over: Partial<DialTask> = {}): string {
  return buildCallBrief({
    task: { ...TASK, ...over },
    family: getCallFamily('general_inquiry'),
    candidate: {
      id: 'c1',
      name: "Bill's",
      category: 'restaurant',
      address: '1 High Street, London',
      latitude: null,
      longitude: null,
      phoneE164: '+442071234567',
      phoneRaw: '020 7123 4567',
      website: null,
      source: 'osm',
      sourceUrl: null,
      rating: null,
      reviewCount: null,
      distanceMeters: 400,
      openingHours: null,
      phoneVerified: false,
      verificationSources: [],
    },
    policy: DEFAULT_USER_POLICY,
    mayCommit: false,
    userFacts: {},
    userDisplayName: null,
  });
}

describe('when to end the call', () => {
  it('caps how many times the same thing is asked', () => {
    expect(brief()).toMatch(/at most twice/i);
  });

  it('ends the call when the business sends you to a website', () => {
    // The exact case: "our team will be able to help you on our website via our
    // live chat or our Contact us form."
    const text = brief();
    expect(text).toMatch(/cannot help by phone/i);
    expect(text).toMatch(/website/i);
    expect(text).toMatch(/Do not rephrase and try again/i);
  });

  it('recognises a recording by its repetition', () => {
    const text = brief();
    expect(text).toMatch(/same thing/i);
    expect(text).toMatch(/recording or a script/i);
  });

  it('does not let holding become a loop', () => {
    expect(brief()).toMatch(/do not wait a second time/i);
  });

  it('says plainly that ending with no answer is a good outcome', () => {
    // Otherwise persistence looks like the helpful choice, which is how a
    // fifteen-exchange call happens without anything going obviously wrong.
    expect(brief()).toMatch(/Ending politely with no answer is a good outcome/i);
  });

  it('asks for the refusal in the business’s own words', () => {
    // "Only takes enquiries via the website" is a real answer about this
    // business. "Unknown" with no reason is not.
    expect(brief()).toMatch(/refused, or could only direct you elsewhere/i);
  });
});

describe('what the brief has always had to say', () => {
  it('discloses that this is an AI, before anything else', () => {
    const text = brief();
    expect(text).toMatch(/Identify yourself as an AI assistant/i);
    expect(text.indexOf('Identify yourself as an AI')).toBeLessThan(text.indexOf('WHY'));
  });

  it('forbids committing to anything on an information-only call', () => {
    expect(brief()).toMatch(/Do NOT book, reserve, order, hold, or agree to anything/i);
  });

  it('forbids inventing an answer', () => {
    expect(brief()).toMatch(/Do not invent an answer/i);
  });

  it('carries the purpose in the user’s own words when there is one', () => {
    const text = brief({ callPurpose: 'check whether there is ice cream' });
    expect(text).toMatch(/The caller asked specifically: check whether there is ice cream/);
  });
});
