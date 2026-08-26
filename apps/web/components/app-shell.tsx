'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { SessionUser, TaskSummary } from '@dial/schemas';
import {
  BrandMark,
  PlusIcon,
  SearchIcon,
  TargetIcon,
  ContactsIcon,
  ClockIcon,
  PhoneIcon,
  CardIcon,
  KeyIcon,
  UserIcon,
} from './icons';

/**
 * The application shell, laid out to match the supplied screenshot: a
 * borderless sidebar on the page-tinted background, a near-black pill for the
 * primary action, plain-text navigation with line icons, and the content in a
 * white rounded panel floating on the tint.
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
]);

export function AppShell({
  user,
  recents,
  children,
}: {
  user: SessionUser;
  recents: TaskSummary[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const isCurrent = (href: string) => (pathname === href ? 'page' : undefined);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <Link href="/" className="brand">
          <BrandMark size={32} className="brand-mark" />
          <span>DIAL</span>
        </Link>

        <button type="button" className="new-task-button" onClick={() => router.push('/')}>
          <PlusIcon size={20} />
          New task
        </button>

        <div className="nav">
          <Link href="/history" className="nav-item" aria-current={isCurrent('/history')}>
            <SearchIcon size={20} />
            Search tasks
          </Link>
          <Link href="/history" className="nav-item">
            <TargetIcon size={20} />
            Results
          </Link>
          <Link href="/contacts" className="nav-item" aria-current={isCurrent('/contacts')}>
            <ContactsIcon size={20} />
            Contacts
          </Link>
        </div>

        <div className="nav-divider" />

        <div className="nav-heading">
          <ClockIcon size={20} />
          Recents
        </div>

        <div className="recents">
          {recents.length === 0 ? (
            <p
              style={{
                padding: '4px 12px 4px 34px',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-text-muted)',
                margin: 0,
              }}
            >
              Nothing yet
            </p>
          ) : (
            recents.map((task) => (
              <Link
                key={task.id}
                href={`/tasks/${task.id}`}
                className="recent-item"
                title={task.instruction}
              >
                <span
                  className="recent-dot"
                  data-live={LIVE_STATES.has(task.state) ? 'true' : 'false'}
                />
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {task.instruction}
                </span>
              </Link>
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <div className="nav-divider" />
          <Link href="/settings" className="nav-item" aria-current={isCurrent('/settings')}>
            <PhoneIcon size={20} />
            Calling
          </Link>
          <Link href="/settings" className="nav-item">
            <CardIcon size={20} />
            Usage
          </Link>
          <Link href="/settings" className="nav-item">
            <KeyIcon size={20} />
            Permissions
          </Link>
          <Link href="/settings" className="nav-item">
            <UserIcon size={20} />
            {user.name}
          </Link>
        </div>
      </nav>

      <main className="main">
        <div className="panel">{children}</div>
      </main>
    </div>
  );
}
