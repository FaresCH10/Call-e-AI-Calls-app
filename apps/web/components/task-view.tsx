'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { TaskDetail, ComparableOutcome } from '@dial/schemas';
import { proxied, ApiError } from '@/lib/api';
import { CheckIcon, PhoneIcon, MapPinIcon } from './icons';

/**
 * The live task screen.
 *
 * Every line of progress here comes from a persisted task event — there is no
 * timer faking motion. When the stream is quiet, the task genuinely is not
 * moving, and refreshing the page shows exactly the same thing.
 */

const LIVE_STATES = new Set([
  'created',
  'interpreting',
  'researching',
  'candidates_ready',
  'planning_calls',
  'calling',
  'collecting_results',
  'comparing',
  'executing_action',
]);

const TONES: Record<string, 'neutral' | 'active' | 'success' | 'warning' | 'danger'> = {
  completed: 'success',
  partially_completed: 'warning',
  failed: 'danger',
  canceled: 'neutral',
  needs_user_input: 'warning',
  awaiting_confirmation: 'warning',
};

function toneStyle(tone: string): React.CSSProperties {
  switch (tone) {
    case 'success':
      return { background: 'var(--color-success-soft)', color: 'var(--color-success)' };
    case 'warning':
      return { background: 'var(--color-warning-soft)', color: 'var(--color-warning)' };
    case 'danger':
      return { background: 'var(--color-danger-soft)', color: 'var(--color-danger)' };
    case 'active':
      return { background: 'var(--color-info-soft)', color: 'var(--color-info)' };
    default:
      return { background: 'var(--color-surface-muted)', color: 'var(--color-text-secondary)' };
  }
}

export function TaskView({ initial }: { initial: TaskDetail }) {
  const [task, setTask] = useState<TaskDetail>(initial);
  const [busy, setBusy] = useState(false);
  const [contactName, setContactName] = useState('');
  // The business the user has asked Dial to ring back, and what for.
  const [actOn, setActOn] = useState<ComparableOutcome['candidate'] | null>(null);
  const [actInstruction, setActInstruction] = useState('');
  const called = new Set(task.calls.map((c) => c.candidateId));
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [gone, setGone] = useState(false);
  const [intake, setIntake] = useState<Record<string, string>>({});
  const router = useRouter();

  const live = LIVE_STATES.has(task.state) && !gone;

  const refresh = useCallback(async () => {
    try {
      setTask(await proxied.getTask(task.id));
    } catch (caught) {
      // A deleted task is gone for good — stop asking for it. Anything else is
      // transient and must not blank the screen the user is reading.
      if (caught instanceof ApiError && caught.status === 404) setGone(true);
    }
  }, [task.id]);

  // Progress arrives over SSE. The stream carries state changes; the detail
  // itself is re-fetched, so the client never has to reconstruct the model.
  useEffect(() => {
    if (!live) return;
    const source = new EventSource(`/api/be/events?taskId=${encodeURIComponent(task.id)}`);
    source.onmessage = () => void refresh();
    source.onerror = () => {
      // EventSource reconnects on its own; a poll keeps things moving if it cannot.
    };
    const fallback = setInterval(() => void refresh(), 5000);
    return () => {
      source.close();
      clearInterval(fallback);
    };
  }, [live, task.id, refresh]);

  async function act(fn: () => Promise<unknown>, options: { refreshAfter?: boolean } = {}) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Deleting navigates away; re-fetching the row we just removed would
      // simply 404 and put a spurious error in the console.
      if (options.refreshAfter !== false) await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const result = task.result;
  const tone = TONES[task.state] ?? (live ? 'active' : 'neutral');

  return (
    <div className="task-body">
      <header className="page-header" style={{ margin: 0 }}>
        <span className="status-pill" style={toneStyle(tone)}>
          {live ? <Spinner /> : null}
          {task.stateLabel}
        </span>
        <h1 className="page-title" style={{ marginTop: 12 }}>
          {task.instruction}
        </h1>
        {task.headline && task.headline !== task.instruction ? (
          <p className="page-subtitle">{task.headline}</p>
        ) : null}
      </header>

      {gone ? (
        <div className="notice" data-tone="warning" role="status">
          This task has been deleted. Nothing further will happen on it.
        </div>
      ) : null}

      {/*
        Section 31: a simulated outcome must never be mistaken for a real one.
        Driven by what each call actually recorded, not by current config, so a
        task run in dry run stays labelled even after the server goes live.
      */}
      {task.calls.some((call) => call.simulated) ? (
        <div className="notice" data-tone="warning" role="status">
          <strong>Simulated calls — no telephone call was placed.</strong>
          <p style={{ margin: '6px 0 0' }}>
            These businesses were found for real, but Dial did not ring them. The outcomes,
            prices and transcripts below are generated by the dry-run provider and mean
            nothing about the real world. Set <code>TEST_PROVIDER=real</code> with a CALL-E
            key to place actual calls.
          </p>
        </div>
      ) : null}

      {/* The intake questions block the work, so they come first. */}
      {task.clarifyingQuestions.length > 0 ? (
        <section className="card">
          <div className="card-label">A few quick questions</div>
          <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
            Answering these lets Dial call the right places and ask the right things. Skip any
            you are not sure about.
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(() =>
                proxied.answerQuestions(
                  task.id,
                  Object.entries(intake).map(([id, answer]) => ({ id, answer })),
                ),
              );
            }}
          >
            {task.clarifyingQuestions.map((question) => (
              <div className="field" key={question.id}>
                <label htmlFor={`q-${question.id}`}>
                  {question.question}
                  {question.required ? (
                    <span style={{ color: 'var(--color-danger)' }} aria-hidden> *</span>
                  ) : null}
                </label>
                {question.why ? (
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                    {question.why}
                  </span>
                ) : null}

                {question.options.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                    {question.options.map((option) => {
                      const selected = intake[question.id] === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          className="button"
                          aria-pressed={selected}
                          data-variant={selected ? 'primary' : undefined}
                          onClick={() =>
                            setIntake((prev) => ({
                              ...prev,
                              // Tapping the selected chip clears it, so a
                              // mistaken tap is not a trap.
                              [question.id]: selected ? '' : option,
                            }))
                          }
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <input
                  id={`q-${question.id}`}
                  value={intake[question.id] ?? ''}
                  onChange={(event) =>
                    setIntake((prev) => ({ ...prev, [question.id]: event.target.value }))
                  }
                  placeholder={question.options.length ? 'Or type your own' : 'Your answer'}
                  maxLength={500}
                />
              </div>
            ))}

            <div className="button-row">
              <button className="button" data-variant="primary" disabled={busy}>
                Start calling
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void act(() => proxied.answerQuestions(task.id, [], true))}
              >
                Skip and go
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {/*
        Offered only when the user supplied the number and has not kept it. The
        number never travels back to the server -- the task already holds it, so
        saving refers to the task.
      */}
      {task.directPhone && !task.directPhoneSaved ? (
        <section className="card">
          <div className="card-label">Keep this number?</div>
          <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
            Give {task.directPhone} a name and Dial will use it next time instead of the bare
            number.
          </p>
          <div className="field">
            <label htmlFor="save-contact">Name</label>
            <input
              id="save-contact"
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
              placeholder="Ahmed at the garage"
              maxLength={80}
            />
          </div>
          <div className="button-row">
            <button
              className="button"
              data-variant="primary"
              disabled={busy || !contactName.trim()}
              onClick={() =>
                void act(() => proxied.saveContact({ taskId: task.id, name: contactName.trim() }))
              }
            >
              Save to contacts
            </button>
          </div>
        </section>
      ) : null}

      {/*
        Dial found this business, rang it and got an answer. Asking the user to
        pick the phone up themselves to act on that answer wastes the thing that
        was just established -- so Dial rings back, and the user says what for.
      */}
      {actOn ? (
        <section className="card">
          <div className="card-label">Have Dial call {actOn.name}</div>
          <div className="field">
            <label htmlFor="act-instruction">What should Dial do?</label>
            <input
              id="act-instruction"
              value={actInstruction}
              onChange={(event) => setActInstruction(event.target.value)}
              placeholder="Book me in for tomorrow morning"
              maxLength={500}
              autoFocus
            />
          </div>
          <div className="button-row">
            <button
              className="button"
              data-variant="primary"
              disabled={busy || !actInstruction.trim()}
              onClick={() =>
                void act(async () => {
                  const started = (await proxied.actOnBusiness(
                    task.id,
                    actOn.id,
                    actInstruction.trim(),
                  )) as { id: string };
                  router.push(`/tasks/${started.id}`);
                  return started;
                }, { refreshAfter: false })
              }
            >
              Ask Dial to call
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setActOn(null);
                setActInstruction('');
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {/* Anything needing the user comes first — it is blocking the work. */}
      {task.state === 'needs_user_input' && task.clarificationQuestion ? (
        <section className="card">
          <div className="card-label">Dial needs one detail</div>
          <p style={{ marginTop: 0 }}>{task.clarificationQuestion}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!answer.trim()) return;
              void act(() => proxied.answerClarification(task.id, answer.trim()));
            }}
          >
            <div className="field">
              <label htmlFor="clarify">Your answer</label>
              <input
                id="clarify"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="e.g. Dublin 2"
                maxLength={1000}
              />
            </div>
            <button className="button" data-variant="primary" disabled={busy || !answer.trim()}>
              Continue
            </button>
          </form>
        </section>
      ) : null}

      {task.pendingAuthorization ? (
        <section className="card">
          <div className="card-label">Needs your approval</div>
          <p style={{ marginTop: 0 }}>{task.pendingAuthorization.prompt}</p>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
            Dial has not called anyone yet and will not until you approve.
          </p>
          <div className="button-row">
            <button
              className="button"
              data-variant="primary"
              disabled={busy}
              onClick={() => void act(() => proxied.decideAuthorization(task.id, true))}
            >
              Approve
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => void act(() => proxied.decideAuthorization(task.id, false))}
            >
              Not now
            </button>
          </div>
        </section>
      ) : null}

      {/* Progress */}
      {task.events.length > 0 ? (
        <section className="card">
          <div className="card-label">Progress</div>
          <ol className="progress-list">
            {task.events.map((event, index) => {
              const isLast = index === task.events.length - 1;
              return (
                <li
                  key={event.id}
                  className="progress-item"
                  data-latest={isLast && live ? 'true' : 'false'}
                >
                  <span className="progress-marker" aria-hidden>
                    {isLast && live ? '●' : '✓'}
                  </span>
                  <span>{event.message}</span>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {/* The answer */}
      {result?.best ? (
        <BestResult outcome={result.best} tally={result.tally} onAct={setActOn} />
      ) : null}

      {result && result.caveats.length > 0 ? (
        <div className="notice" data-tone="warning">
          <strong>Worth knowing</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {result.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result && (result.best || result.alternatives.length > 0 || result.unusable.length > 0) ? (
        <section className="card">
          <div className="card-label">Compared</div>
          {/*
            Everything Dial rang and got something from, including the ones it
            could not compare. Showing only the winner would hide how thin or
            how solid the basis for choosing it was.
          */}
          <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
            {result.tally.comparable === 0
              ? 'Nothing comparable came back.'
              : result.tally.comparable === 1
                ? 'Only one business gave a comparable answer, so there was nothing to weigh it against.'
                : `Dial compared ${result.tally.comparable} businesses that gave a usable answer` +
                  (result.best ? ` and picked ${result.best.candidate.name}.` : '.')}
            {result.best && result.best.rankReasons.length > 0
              ? ` ${result.best.rankReasons.join(' · ')}.`
              : ''}
          </p>
          <div className="table-scroll">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th scope="col">Business</th>
                  <th scope="col">Price</th>
                  <th scope="col">Notes</th>
                  <th scope="col">Distance</th>
                  <th scope="col" aria-label="Act" />
                </tr>
              </thead>
              <tbody>
                {[result.best, ...result.alternatives, ...result.unusable]
                  .filter((o): o is ComparableOutcome => Boolean(o))
                  .map((outcome) => (
                    <tr key={outcome.callId}>
                      <td>{outcome.candidate.name}</td>
                      <td>
                        {outcome.normalizedPrice !== null
                          ? `${outcome.normalizedCurrency ?? ''} ${outcome.normalizedPrice.toFixed(2)}`
                          : 'Not quoted'}
                        {!outcome.viable ? (
                          <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                            Not comparable
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {outcome.highlights.slice(0, 3).join(' · ') || '—'}
                        {outcome.normalizationNotes.length > 0 ? (
                          <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                            {outcome.normalizationNotes.join(' · ')}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {outcome.candidate.distanceMeters !== null
                          ? `${(outcome.candidate.distanceMeters / 1000).toFixed(1)} km`
                          : '—'}
                      </td>
                      <td>
                        {/*
                          Any business that answered can be acted on, not only
                          the one that came top: cheapest is not always wanted.
                        */}
                        {outcome.candidate.phoneE164 ? (
                          <button
                            type="button"
                            className="button"
                            disabled={busy}
                            onClick={() => setActOn(outcome.candidate)}
                          >
                            Have Dial call
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* What happened on every call, including the ones that got nowhere. */}
      {task.calls.length > 0 ? (
        <section className="card">
          <div className="card-label">Calls Dial made</div>
          <div className="table-scroll">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th scope="col">Business</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {task.calls.map((call) => (
                  <tr key={call.id}>
                    <td>
                      {call.businessName}
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                        {call.phoneMasked}
                      </div>
                      {call.simulated ? (
                        <span
                          className="status-pill"
                          style={{
                            background: 'var(--color-warning-soft)',
                            color: 'var(--color-warning)',
                            marginTop: 4,
                          }}
                        >
                          Simulated
                        </span>
                      ) : null}
                    </td>
                    <td>{dispositionLabel(call.disposition)}</td>
                    <td style={{ color: 'var(--color-text-secondary)' }}>
                      {(call.structuredResult?.['evidence_summary'] as string) ??
                        call.failureMessage ??
                        call.summary ??
                        '—'}
                      {call.transcript.length > 0 ? (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ cursor: 'pointer' }}>Transcript</summary>
                          <div style={{ marginTop: 6 }}>
                            {call.transcript.map((turn, index) => (
                              <p key={index} style={{ margin: '2px 0' }}>
                                <strong>{turn.speaker === 'bot' ? 'Dial' : 'Business'}:</strong>{' '}
                                {turn.text}
                              </p>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {task.candidates.length > 0 ? (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Where Dial looked ({task.candidates.length} businesses found)
          </summary>
          <div className="table-scroll" style={{ marginTop: 16 }}>
            <table className="comparison-table">
              <thead>
                <tr>
                  <th scope="col">Business</th>
                  <th scope="col">Source</th>
                  <th scope="col">Why / why not</th>
                  <th scope="col" aria-label="Call" />
                </tr>
              </thead>
              <tbody>
                {task.candidates.map((entry) => (
                  <tr key={entry.candidate.id}>
                    <td>
                      {entry.candidate.name}
                      {entry.candidate.address ? (
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                          {entry.candidate.address}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {entry.candidate.sourceUrl ? (
                        <a
                          href={entry.candidate.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ textDecoration: 'underline' }}
                        >
                          {entry.candidate.source}
                        </a>
                      ) : (
                        entry.candidate.source
                      )}
                    </td>
                    <td style={{ color: 'var(--color-text-secondary)' }}>
                      {entry.excludedReason ?? entry.reasons.join(' · ') ?? '—'}
                    </td>
                    <td>
                      {/*
                        Dial rings the ones it ranked highest, which is a
                        judgement and can be wrong. The user sees the whole
                        list, so let them override it.
                      */}
                      {entry.candidate.phoneE164 ? (
                        called.has(entry.candidate.id) ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>Called</span>
                        ) : (
                          <button
                            type="button"
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              void act(() => proxied.callCandidate(task.id, entry.candidate.id))
                            }
                          >
                            Call this one
                          </button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {error ? (
        <div className="notice" data-tone="danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="button-row">
        {live ? (
          <button
            className="button"
            data-variant="danger"
            disabled={busy}
            onClick={() => void act(() => proxied.cancelTask(task.id))}
          >
            Stop this task
          </button>
        ) : null}
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void act(
              async () => {
                await proxied.deleteTask(task.id);
                setGone(true);
                router.push('/history');
                // Without this the sidebar keeps offering the deleted task.
                router.refresh();
              },
              { refreshAfter: false },
            )
          }
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function BestResult({
  outcome,
  tally,
  onAct,
}: {
  outcome: ComparableOutcome;
  tally: TaskDetail['result'] extends infer R ? (R extends { tally: infer T } ? T : never) : never;
  onAct: (candidate: ComparableOutcome['candidate']) => void;
}) {
  const mapsUrl =
    outcome.candidate.latitude !== null && outcome.candidate.longitude !== null
      ? `https://www.openstreetmap.org/?mlat=${outcome.candidate.latitude}&mlon=${outcome.candidate.longitude}#map=17/${outcome.candidate.latitude}/${outcome.candidate.longitude}`
      : null;

  return (
    <section className="card">
      <div className="card-label">Best verified option</div>
      <div className="result-head">
        <h2 className="result-name">{outcome.candidate.name}</h2>
        {outcome.normalizedPrice !== null ? (
          <p className="result-price">
            {outcome.normalizedCurrency ?? ''} {outcome.normalizedPrice.toFixed(2)}
          </p>
        ) : null}
      </div>

      <ul className="check-list">
        {outcome.rankReasons.map((reason) => (
          <li key={reason}>
            <CheckIcon size={16} />
            {reason}
          </li>
        ))}
      </ul>

      {outcome.conditions.length > 0 ? (
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 0 }}>
          {outcome.conditions.join(' · ')}
        </p>
      ) : null}

      <p className="tally">
        {tally.discovered} found · {tally.contacted} contacted · {tally.answered} answered ·{' '}
        {tally.comparable} comparable
        {tally.verifiedAt ? ` · verified by phone at ${formatTime(tally.verifiedAt)}` : ''}
      </p>

      <div className="button-row">
        {outcome.candidate.phoneE164 ? (
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => onAct(outcome.candidate)}
          >
            <PhoneIcon size={18} />
            Have Dial call them
          </button>
        ) : null}
        {outcome.candidate.phoneE164 ? (
          <a className="button" href={`tel:${outcome.candidate.phoneE164}`}>
            <PhoneIcon size={18} />
            Call them myself
          </a>
        ) : null}
        {mapsUrl ? (
          <a className="button" href={mapsUrl} target="_blank" rel="noopener noreferrer">
            <MapPinIcon size={18} />
            Directions
          </a>
        ) : null}
      </div>
    </section>
  );
}

function dispositionLabel(disposition: string): string {
  const labels: Record<string, string> = {
    pending: 'In progress',
    answered_useful: 'Answered',
    answered_no_answer_to_question: "Answered, couldn't say",
    refused: 'Declined to answer',
    no_answer: 'No answer',
    voicemail: 'Voicemail',
    failed: "Couldn't connect",
    needs_review: 'Answer unclear',
    not_needed: 'Not needed',
  };
  return labels[disposition] ?? disposition;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'currentColor',
        display: 'inline-block',
        animation: 'pulse 1.4s ease-in-out infinite',
      }}
    />
  );
}
