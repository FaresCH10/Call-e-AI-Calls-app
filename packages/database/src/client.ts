import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { config } from '@dial/config';
import { logger } from '@dial/observability';
import * as schema from './schema.js';
import { MIGRATIONS } from './migrations.js';

/**
 * One database, two drivers.
 *
 * - DATABASE_URL set  -> real PostgreSQL over node-postgres (production).
 * - DATABASE_URL empty -> PGlite, which is genuine PostgreSQL compiled to WASM,
 *   stored on disk at .pgdata/. Real SQL, real constraints, real transactions --
 *   so a foreign key or unique-index violation fails in development exactly as
 *   it would in production. It is not a stub or an in-memory fake.
 *
 * PGlite is refused in production by the config layer.
 */

export type Db = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Db;
  driver: 'pglite' | 'postgres';
  close: () => Promise<void>;
}

let handle: DatabaseHandle | null = null;

export async function createDatabase(options?: {
  url?: string;
  /** PGlite data directory; 'memory://' gives a throwaway instance for tests. */
  dataDir?: string;
}): Promise<DatabaseHandle> {
  const url = options?.url ?? config().databaseUrl;

  if (url) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema });
    return {
      db,
      driver: 'postgres',
      close: async () => {
        await pool.end();
      },
    };
  }

  const dataDir = options?.dataDir ?? process.env.PGLITE_DIR ?? '.pgdata';
  const client = new PGlite(dataDir);
  await client.waitReady;
  // The query surface drizzle exposes is identical across both drivers; the
  // cast keeps one Db type across the codebase instead of a union at every use.
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return {
    db,
    driver: 'pglite',
    close: async () => {
      await client.close();
    },
  };
}

export async function getDatabase(): Promise<DatabaseHandle> {
  if (!handle) handle = await createDatabase();
  return handle;
}

export async function closeDatabase(): Promise<void> {
  if (handle) {
    await handle.close();
    handle = null;
  }
}

/**
 * Splits a migration into individual statements.
 *
 * Necessary because PGlite executes through the extended query protocol, which
 * rejects multiple commands in one prepared statement ("cannot insert multiple
 * commands into a prepared statement"). The split is quote-aware so a semicolon
 * inside a string literal or a dollar-quoted body does not end a statement.
 */
export function splitStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inLineComment = false;
  let dollarTag: string | null = null;

  for (let i = 0; i < sqlText.length; i += 1) {
    const char = sqlText[i]!;
    const next = sqlText[i + 1];

    if (inLineComment) {
      current += char;
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (!inSingle && !dollarTag && char === '-' && next === '-') {
      inLineComment = true;
      current += char;
      continue;
    }
    if (dollarTag) {
      current += char;
      if (sqlText.startsWith(dollarTag, i)) {
        current += sqlText.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (!inSingle && char === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sqlText.slice(i));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (char === "'") {
      // '' inside a literal is an escaped quote, not a terminator.
      if (inSingle && next === "'") {
        current += "''";
        i += 1;
        continue;
      }
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === ';' && !inSingle) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Applies any migration not already recorded. Safe to run repeatedly. */
export async function runMigrations(db: Db): Promise<string[]> {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const existing = await db.execute<{ id: string }>(sql`SELECT id FROM _migrations`);
  const applied = new Set((existing.rows ?? []).map((r) => r.id));
  const ran: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    for (const statement of splitStatements(migration.sql)) {
      await db.execute(sql.raw(statement));
    }
    await db.execute(sql`INSERT INTO _migrations (id) VALUES (${migration.id})`);
    ran.push(migration.id);
    logger.info('migration applied', { migration: migration.id });
  }
  return ran;
}

export { schema };
