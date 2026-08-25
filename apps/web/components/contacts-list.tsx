'use client';

import { useState } from 'react';
import type { Contact } from '@dial/schemas';
import { proxied, ApiError } from '@/lib/api';

/**
 * Numbers the user chose to keep.
 *
 * Renaming is the whole point of the page. "+971 56 341 8581" tells you nothing
 * a month later; "Ahmed at the garage" tells you everything, and it is the name
 * Dial then uses in the timeline and the results rather than describing the
 * call as being to an anonymous number.
 *
 * Numbers are shown in full here, unlike everywhere else in the app. The masking
 * elsewhere protects numbers Dial found; these are numbers the user typed and
 * saved themselves, and hiding them would only stop them recognising their own
 * address book.
 */
export function ContactsList({ initial }: { initial: Contact[] }) {
  const [contacts, setContacts] = useState<Contact[]>(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  async function act<T>(run: () => Promise<T>, after: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      after(await run());
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Contacts</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginTop: 0 }}>
        Numbers you have kept. Dial uses these names when it calls, so give them names that
        will still mean something later.
      </p>

      {error ? (
        <div className="notice" data-tone="warning" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      <section className="card">
        <div className="card-label">Add a number</div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!newName.trim() || !newPhone.trim()) return;
            void act(
              () => proxied.saveContact({ name: newName.trim(), phone: newPhone.trim() }),
              (saved) => {
                setContacts((prev) =>
                  [...prev.filter((c) => c.id !== saved.id), saved].sort((a, b) =>
                    a.name.localeCompare(b.name),
                  ),
                );
                setNewName('');
                setNewPhone('');
              },
            );
          }}
        >
          <div className="field">
            <label htmlFor="contact-name">Name</label>
            <input
              id="contact-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Ahmed at the garage"
              maxLength={80}
            />
          </div>
          <div className="field">
            <label htmlFor="contact-phone">Phone number</label>
            <input
              id="contact-phone"
              value={newPhone}
              onChange={(event) => setNewPhone(event.target.value)}
              placeholder="+971 56 341 8581"
              inputMode="tel"
              maxLength={30}
            />
          </div>
          <button className="button" data-variant="primary" disabled={busy}>
            Save contact
          </button>
        </form>
      </section>

      {contacts.length === 0 ? (
        <div className="empty-state">
          No contacts yet. Save one above, or keep a number after Dial calls it.
        </div>
      ) : (
        <section className="card">
          <div className="card-label">Saved ({contacts.length})</div>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Number</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id}>
                  <td>
                    {editing === contact.id ? (
                      <input
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        aria-label={`New name for ${contact.name}`}
                        maxLength={80}
                        autoFocus
                      />
                    ) : (
                      contact.name
                    )}
                  </td>
                  <td style={{ color: 'var(--color-text-secondary)' }}>{contact.phoneE164}</td>
                  <td>
                    <div className="button-row">
                      {editing === contact.id ? (
                        <>
                          <button
                            className="button"
                            data-variant="primary"
                            disabled={busy || !draftName.trim()}
                            onClick={() =>
                              void act(
                                () => proxied.renameContact(contact.id, draftName.trim()),
                                (updated) => {
                                  setContacts((prev) =>
                                    prev.map((c) => (c.id === updated.id ? updated : c)),
                                  );
                                  setEditing(null);
                                },
                              )
                            }
                          >
                            Save
                          </button>
                          <button className="button" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="button"
                            onClick={() => {
                              setEditing(contact.id);
                              setDraftName(contact.name);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () => proxied.deleteContact(contact.id),
                                () =>
                                  setContacts((prev) => prev.filter((c) => c.id !== contact.id)),
                              )
                            }
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
