import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, signUp, createTask, type Harness } from './harness.js';

/**
 * The sidebar's recents.
 *
 * A newly created task did not appear until the page was reloaded. These pin
 * the half of it the server owns: the list must contain the task the moment it
 * is created, and it must be at the top. Anything still missing after that is
 * the client not re-rendering, which is where the fix went.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function listTasks(token: string) {
  const response = await h.app.inject({
    method: 'GET',
    url: '/api/tasks',
    headers: { authorization: `Bearer ${token}` },
  });
  return (response.json() as { tasks: Array<{ id: string; instruction: string }> }).tasks;
}

describe('recents', () => {
  it('contains a task the instant it is created', async () => {
    h = await createHarness({});
    const user = await signUp(h);

    expect(await listTasks(user.token)).toHaveLength(0);

    const created = await createTask(h, user.token, 'Find an iPhone repair shop');
    // No drain, no waiting: the row exists as soon as the request returns.
    const tasks = await listTasks(user.token);
    expect(tasks.map((t) => t.id)).toContain(created.id);
  });

  it('puts the newest first, so it lands at the top of the list', async () => {
    h = await createHarness({});
    const user = await signUp(h);

    const first = await createTask(h, user.token, 'First task');
    const second = await createTask(h, user.token, 'Second task');
    const third = await createTask(h, user.token, 'Third task');

    const tasks = await listTasks(user.token);
    expect(tasks.map((t) => t.id)).toEqual([third.id, second.id, first.id]);
  });
});
