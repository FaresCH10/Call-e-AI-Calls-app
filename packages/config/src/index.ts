import { z } from 'zod';
import { loadEnv } from './env.js';

export { loadEnv };

loadEnv();

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === '1' || v.toLowerCase() === 'true'));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  HOST: z.string().default('0.0.0.0'),

  TEST_PROVIDER: z.enum(['mock', 'real']).default('mock'),

  CALLE_API_KEY: z.string().default(''),
  CALLE_BASE_URL: z.string().default('https://api.heycall-e.com'),
  CALLE_WEBHOOK_URL: z.string().default(''),

  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('gemini-3.6-flash'),
  LLM_FALLBACK_MODELS: z
    .string()
    .default(
      'gemini-3.5-flash-lite,gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-3.7-flash,gemini-3.5-flash',
    ),
  LLM_REQUIRED: bool(false),

  DISCOVERY_PROVIDER: z.enum(['auto', 'osm', 'google']).default('auto'),
  OSM_CONTACT_EMAIL: z.string().default(''),
  GOOGLE_PLACES_API_KEY: z.string().default(''),
  WEB_SEARCH_API_KEY: z.string().default(''),

  DATABASE_URL: z.string().default(''),
  REDIS_URL: z.string().default(''),

  SESSION_SECRET: z.string().default(''),
  ENCRYPTION_KEY: z.string().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  MAX_CALLS_PER_TASK: int(5),
  MAX_CALL_CONCURRENCY: int(3),
  MAX_CALLS_PER_USER_PER_DAY: int(25),
  CALL_WAVE_SIZE: int(3),
  CALL_POLL_DELAY_MS: int(20000),
  CALL_ANSWER_TIMEOUT_MS: int(30000),
  CALL_MAX_ATTEMPTS_PER_BUSINESS: int(2),

  PUBLIC_WEB_URL: z.string().default('http://localhost:3000'),
  RUN_WORKER_IN_API: z.string().optional(),
});

export type CallMode = 'mock' | 'real';

export interface DialConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  callMode: CallMode;
  calle: { apiKey: string; baseUrl: string; webhookUrl: string; configured: boolean };
  llm: {
    apiKey: string;
    model: string;
    /** Tried in order when the primary model is overloaded. */
    fallbackModels: string[];
    configured: boolean;
    required: boolean;
  };
  discovery: {
    preference: 'auto' | 'osm' | 'google';
    osmContactEmail: string;
    googlePlacesApiKey: string;
    webSearchApiKey: string;
  };
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
  encryptionKey: string;
  corsOrigins: string[];
  limits: {
    maxCallsPerTask: number;
    maxCallConcurrency: number;
    maxCallsPerUserPerDay: number;
    callWaveSize: number;
    /** How long to wait before first asking the provider for a result. */
    pollDelayMs: number;
    /**
     * How long Dial waits on one attempt before giving up on it.
     *
     * This is Dial's patience, not a ring timeout: CALL-E exposes no way to cap
     * how long it rings, and no way to cancel a call in flight. Dial stops
     * waiting and moves to another business; it cannot stop a call already
     * connecting.
     */
    answerTimeoutMs: number;
    /** Attempts at one business before moving on to a different one. */
    maxAttemptsPerBusiness: number;
  };
  publicWebUrl: string;
  /**
   * Run the job loop inside the API process.
   *
   * Defaults to true on PGlite, which is an embedded single-process database:
   * a separate worker cannot open the same data directory. With a real
   * DATABASE_URL it defaults to false, because the two belong in separate
   * processes so a web deploy cannot abandon calls in flight.
   */
  runWorkerInApi: boolean;
}

/**
 * Boot-time fatal checks. The rule these encode: an operator must never be able
 * to believe real calls are happening when they are not, or vice versa.
 */
function assertCoherent(cfg: DialConfig): void {
  const fatal: string[] = [];

  if (cfg.callMode === 'real' && !cfg.calle.apiKey) {
    fatal.push(
      'TEST_PROVIDER=real requires CALLE_API_KEY. Refusing to boot: running the fake ' +
        'provider while the UI claims real calls would be a lie about real-world side effects.',
    );
  }
  if (cfg.llm.required && !cfg.llm.apiKey) {
    fatal.push('LLM_REQUIRED=1 but LLM_API_KEY is empty.');
  }
  if (cfg.isProduction) {
    if (cfg.sessionSecret.length < 32) fatal.push('SESSION_SECRET must be >= 32 chars in production.');
    if (cfg.encryptionKey.length < 32) fatal.push('ENCRYPTION_KEY must be >= 32 chars in production.');
    if (!cfg.databaseUrl) fatal.push('DATABASE_URL is required in production (PGlite is dev/test only).');
  }

  if (fatal.length) {
    throw new Error(`Dial configuration is invalid:\n  - ${fatal.join('\n  - ')}`);
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): DialConfig {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  - ');
    throw new Error(`Dial configuration is invalid:\n  - ${issues}`);
  }
  const raw = parsed.data;

  const cfg: DialConfig = {
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    port: raw.PORT,
    host: raw.HOST,
    callMode: raw.TEST_PROVIDER,
    calle: {
      apiKey: raw.CALLE_API_KEY,
      baseUrl: raw.CALLE_BASE_URL,
      webhookUrl: raw.CALLE_WEBHOOK_URL,
      configured: Boolean(raw.CALLE_API_KEY),
    },
    llm: {
      apiKey: raw.LLM_API_KEY,
      model: raw.LLM_MODEL,
      fallbackModels: raw.LLM_FALLBACK_MODELS.split(',').map((m) => m.trim()).filter(Boolean),
      configured: Boolean(raw.LLM_API_KEY),
      required: raw.LLM_REQUIRED,
    },
    discovery: {
      preference: raw.DISCOVERY_PROVIDER,
      osmContactEmail: raw.OSM_CONTACT_EMAIL,
      googlePlacesApiKey: raw.GOOGLE_PLACES_API_KEY,
      webSearchApiKey: raw.WEB_SEARCH_API_KEY,
    },
    databaseUrl: raw.DATABASE_URL,
    redisUrl: raw.REDIS_URL,
    sessionSecret: raw.SESSION_SECRET || 'dev-only-insecure-session-secret-change-me-now',
    encryptionKey: raw.ENCRYPTION_KEY || 'dev-only-insecure-encryption-key-change-me-now',
    corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    limits: {
      maxCallsPerTask: raw.MAX_CALLS_PER_TASK,
      maxCallConcurrency: raw.MAX_CALL_CONCURRENCY,
      maxCallsPerUserPerDay: raw.MAX_CALLS_PER_USER_PER_DAY,
      callWaveSize: raw.CALL_WAVE_SIZE,
      pollDelayMs: raw.CALL_POLL_DELAY_MS,
      answerTimeoutMs: raw.CALL_ANSWER_TIMEOUT_MS,
      maxAttemptsPerBusiness: raw.CALL_MAX_ATTEMPTS_PER_BUSINESS,
    },
    publicWebUrl: raw.PUBLIC_WEB_URL,
    runWorkerInApi:
      raw.RUN_WORKER_IN_API === undefined || raw.RUN_WORKER_IN_API === ''
        ? !raw.DATABASE_URL
        : raw.RUN_WORKER_IN_API === '1' || raw.RUN_WORKER_IN_API.toLowerCase() === 'true',
  };

  assertCoherent(cfg);
  return cfg;
}

let cached: DialConfig | null = null;
export function config(): DialConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
/** Test-only: forget the memoised config so env changes take effect. */
export function resetConfigCache(): void {
  cached = null;
}
