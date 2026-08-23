import Link from 'next/link';
import { getTasks } from '@/lib/session';

const TONE: Record<string, { bg: string; fg: string }> = {
  completed: { bg: 'var(--color-success-soft)', fg: 'var(--color-success)' },
  partially_completed: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning)' },
  failed: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger)' },
  canceled: { bg: 'var(--color-surface-muted)', fg: 'var(--color-text-secondary)' },
};

export default async function HistoryPage() {
  const data = await getTasks();
  const tasks = data?.tasks ?? [];

  return (
    <div className="task-body">
      <header className="page-header" style={{ margin: 0 }}>
        <h1 className="page-title">Your tasks</h1>
        <p className="page-subtitle">
          Everything Dial has worked on, on any device you are signed in to.
        </p>
      </header>

      {tasks.length === 0 ? (
        <div className="empty-state">
          <p>No tasks yet.</p>
          <Link className="button" data-variant="primary" href="/">
            Start one
          </Link>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
          {tasks.map((task) => {
            const tone = TONE[task.state] ?? {
              bg: 'var(--color-info-soft)',
              fg: 'var(--color-info)',
            };
            return (
              <li key={task.id}>
                <Link href={`/tasks/${task.id}`} className="card" style={{ display: 'block' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      alignItems: 'flex-start',
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong style={{ fontSize: 'var(--text-md)' }}>{task.instruction}</strong>
                    <span
                      className="status-pill"
                      style={{ background: tone.bg, color: tone.fg }}
                    >
                      {task.stateLabel}
                    </span>
                  </div>
                  {task.headline ? (
                    <p style={{ color: 'var(--color-text-secondary)', margin: '8px 0 0' }}>
                      {task.headline}
                    </p>
                  ) : null}
                  <p
                    style={{
                      color: 'var(--color-text-muted)',
                      fontSize: 'var(--text-sm)',
                      margin: '8px 0 0',
                    }}
                  >
                    {new Date(task.createdAt).toLocaleString()}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
