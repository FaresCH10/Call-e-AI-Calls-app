'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UserSettings } from '@dial/schemas';
import { proxied, ApiError } from '@/lib/api';

/**
 * Section 11 / section 20. The authorization policy, in the user's words.
 * Everything here is enforced server-side; the form only edits stored rows.
 */

const AUTOMATION = [
  { value: 'automatic', label: 'Do it automatically' },
  { value: 'ask', label: 'Ask me first' },
  { value: 'never', label: 'Never' },
];

const DISCLOSURE = [
  { value: 'allow', label: 'Share it' },
  { value: 'ask', label: 'Ask me first' },
  { value: 'never', label: 'Never share it' },
];

export function SettingsForm({ initial }: { initial: UserSettings }) {
  const [settings, setSettings] = useState<UserSettings>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const router = useRouter();

  function setPolicy<K extends keyof UserSettings['policy']>(
    key: K,
    value: UserSettings['policy'][K],
  ) {
    setSettings((prev) => ({ ...prev, policy: { ...prev.policy, [key]: value } }));
  }

  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const updated = await proxied.updateSettings(settings);
      setSettings(updated);
      setStatus('saved');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof ApiError ? caught.message : 'Could not save your settings.');
    }
  }

  return (
    <div className="task-body">
      <header className="page-header" style={{ margin: 0 }}>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">What Dial may do on your behalf, and what it must ask about.</p>
      </header>

      <section className="card">
        <div className="card-label">What Dial may do</div>

        <Choice
          label="Gathering information"
          hint="Looking things up and asking businesses questions."
          value={settings.policy.informationGathering}
          options={AUTOMATION}
          onChange={(v) => setPolicy('informationGathering', v as never)}
        />
        <Choice
          label="Making phone calls"
          hint="Dial cannot do anything useful without this."
          value={settings.policy.phoneInquiries}
          options={AUTOMATION}
          onChange={(v) => setPolicy('phoneInquiries', v as never)}
        />
        <Choice
          label="Reservations that need no payment"
          hint="Booking a table, for example."
          value={settings.policy.reservationsWithoutPayment}
          options={AUTOMATION}
          onChange={(v) => setPolicy('reservationsWithoutPayment', v as never)}
        />
        <Choice
          label="Appointments"
          value={settings.policy.appointments}
          options={AUTOMATION}
          onChange={(v) => setPolicy('appointments', v as never)}
        />
        <Choice
          label="Purchases and anything you would have to pay for"
          hint="Dial always asks before this — it cannot be set to automatic."
          value={settings.policy.purchases}
          options={[
            { value: 'ask', label: 'Ask me first' },
            { value: 'never', label: 'Never' },
          ]}
          onChange={(v) => setPolicy('purchases', v as never)}
        />

        <div className="field">
          <label htmlFor="spend">
            Most Dial may commit you to without asking again ({settings.policy.spendCurrency})
          </label>
          <input
            id="spend"
            type="number"
            min={0}
            step="1"
            value={settings.policy.maxAuthorizedSpend}
            onChange={(event) =>
              setPolicy('maxAuthorizedSpend', Number(event.target.value) as never)
            }
          />
        </div>
      </section>

      <section className="card">
        <div className="card-label">What Dial may say about you</div>
        <Choice
          label="Your phone number"
          value={settings.policy.sharePhoneNumber}
          options={DISCLOSURE}
          onChange={(v) => setPolicy('sharePhoneNumber', v as never)}
        />
        <Choice
          label="Your address"
          value={settings.policy.shareAddress}
          options={DISCLOSURE}
          onChange={(v) => setPolicy('shareAddress', v as never)}
        />
        <Choice
          label="Medical information"
          hint="Dial asks every time, whatever this is set to."
          value={settings.policy.shareMedicalInformation}
          options={[
            { value: 'ask', label: 'Ask me each time' },
            { value: 'never', label: 'Never' },
          ]}
          onChange={(v) => setPolicy('shareMedicalInformation', v as never)}
        />
        <Choice
          label="Leaving a voicemail"
          value={settings.policy.leaveVoicemail}
          options={DISCLOSURE.map((o) =>
            o.value === 'allow' ? { value: 'allow', label: 'Leave one' } : o,
          )}
          onChange={(v) => setPolicy('leaveVoicemail', v as never)}
        />
      </section>

      <section className="card">
        <div className="card-label">Language and privacy</div>
        <div className="field">
          <label htmlFor="calling-language">Language Dial should speak on calls</label>
          <input
            id="calling-language"
            value={settings.callingLanguage}
            onChange={(event) =>
              setSettings((prev) => ({ ...prev, callingLanguage: event.target.value }))
            }
            maxLength={20}
          />
        </div>
        <div className="field">
          <label htmlFor="retention">Keep call transcripts for (days, 0 = do not keep them)</label>
          <input
            id="retention"
            type="number"
            min={0}
            max={3650}
            value={settings.transcriptRetentionDays}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                transcriptRetentionDays: Number(event.target.value),
              }))
            }
          />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={settings.askClarifyingQuestions}
            onChange={(event) =>
              setSettings((prev) => ({ ...prev, askClarifyingQuestions: event.target.checked }))
            }
          />
          Ask me a few questions before starting
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={settings.notificationsEnabled}
            onChange={(event) =>
              setSettings((prev) => ({ ...prev, notificationsEnabled: event.target.checked }))
            }
          />
          Tell me when a task finishes
        </label>
      </section>

      {error ? (
        <div className="notice" data-tone="danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="button-row">
        <button
          className="button"
          data-variant="primary"
          onClick={() => void save()}
          disabled={status === 'saving'}
        >
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save settings'}
        </button>
        <button
          className="button"
          onClick={() =>
            void proxied.signOut().then(() => {
              router.push('/sign-in');
              router.refresh();
            })
          }
        >
          Sign out
        </button>
      </div>

      <section className="card">
        <div className="card-label">Delete your account</div>
        <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
          This removes your account, every task, every call record and every transcript. It cannot
          be undone.
        </p>
        {confirmDelete ? (
          <div className="button-row">
            <button
              className="button"
              data-variant="danger"
              onClick={() =>
                void proxied.deleteAccount().then(() => {
                  router.push('/sign-in');
                  router.refresh();
                })
              }
            >
              Yes, delete everything
            </button>
            <button className="button" onClick={() => setConfirmDelete(false)}>
              Keep my account
            </button>
          </div>
        ) : (
          <button className="button" data-variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete my account
          </button>
        )}
      </section>
    </div>
  );
}

function Choice({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const id = label.replace(/\W+/g, '-').toLowerCase();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>{hint}</span>
      ) : null}
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
