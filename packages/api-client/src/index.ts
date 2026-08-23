import type {
  AuthResponse,
  SessionUser,
  TaskSummary,
  TaskDetail,
  TaskListResponse,
  UserSettings,
  HealthResponse,
  CreateTaskRequest,
} from '@dial/schemas';

/**
 * One typed HTTP client, used verbatim by the web app and the mobile app.
 *
 * Auth differs by platform and is handled by the two hooks below rather than by
 * branching inside every call: the browser relies on an httpOnly cookie
 * (`credentials: 'include'`), while React Native supplies a bearer token from
 * secure storage. Nothing here ever holds a server secret.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the user simply needs to sign in again. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns a bearer token, or null to rely on cookies. */
  getToken?: () => string | null | Promise<string | null>;
  /** Included so the browser sends its session cookie. */
  credentials?: RequestCredentials;
  fetchImpl?: typeof fetch;
}

export class DialApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private async request<T>(
    path: string,
    init: RequestInit & { method?: string } = {},
  ): Promise<T> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const token = this.options.getToken ? await this.options.getToken() : null;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (init.body) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: this.options.credentials,
      });
    } catch {
      // Offline, DNS failure, server down — a distinct, actionable state.
      throw new ApiError('network_error', 'Dial could not reach the server.', 0);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } })?.error;
      throw new ApiError(
        error?.code ?? 'request_failed',
        error?.message ?? `Request failed (${response.status}).`,
        response.status,
      );
    }
    return body as T;
  }

  /* ------------------------------------------------------------------ auth */

  signUp(input: { email: string; password: string; name: string }): Promise<AuthResponse> {
    return this.request('/api/auth/sign-up', { method: 'POST', body: JSON.stringify(input) });
  }

  signIn(input: { email: string; password: string }): Promise<AuthResponse> {
    return this.request('/api/auth/sign-in', { method: 'POST', body: JSON.stringify(input) });
  }

  signOut(): Promise<{ ok: boolean }> {
    return this.request('/api/auth/sign-out', { method: 'POST' });
  }

  me(): Promise<{ user: SessionUser }> {
    return this.request('/api/auth/me');
  }

  /* ----------------------------------------------------------------- tasks */

  listTasks(cursor?: string | null): Promise<TaskListResponse> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request(`/api/tasks${query}`);
  }

  createTask(input: CreateTaskRequest): Promise<TaskSummary> {
    return this.request('/api/tasks', { method: 'POST', body: JSON.stringify(input) });
  }

  getTask(id: string): Promise<TaskDetail> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}`);
  }

  answerClarification(id: string, answer: string): Promise<TaskDetail> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/clarify`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
  }

  /** Answers the intake questions. Pass `skipped` when the user chose to skip. */
  answerQuestions(
    id: string,
    answers: Array<{ id: string; answer: string }>,
    skipped = false,
  ): Promise<TaskDetail> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/answers`, {
      method: 'POST',
      body: JSON.stringify({ answers, skipped }),
    });
  }

  decideAuthorization(id: string, approved: boolean): Promise<TaskDetail> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/authorization`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    });
  }

  cancelTask(id: string): Promise<{ ok: boolean; callsAlreadyInFlight: number; note: string | null }> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  deleteTask(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /* -------------------------------------------------------------- settings */

  getSettings(): Promise<UserSettings> {
    return this.request('/api/settings');
  }

  updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    return this.request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
  }

  resolveLocation(input: { text?: string; latitude?: number; longitude?: number }): Promise<{
    latitude: number;
    longitude: number;
    label: string;
    countryCode: string | null;
  }> {
    return this.request('/api/location/resolve', { method: 'POST', body: JSON.stringify(input) });
  }

  deleteAccount(): Promise<{ ok: boolean }> {
    return this.request('/api/account', { method: 'DELETE' });
  }

  health(): Promise<HealthResponse> {
    return this.request('/health');
  }

  /** URL for the SSE progress stream. */
  eventsUrl(taskId?: string): string {
    const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
    return `${this.options.baseUrl}/api/events${query}`;
  }
}

export interface ProgressEvent {
  type: 'state' | 'event' | 'call' | 'result';
  taskId: string;
  state?: string;
  message?: string;
  at: string;
}
