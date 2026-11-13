/**
 * Storage: the whole CRM is one document (settings, leads, campaigns, messages), changed through
 * mutate(), which is atomic: a row lock in Postgres, a write queue for the JSON file.
 *
 * - DATABASE_URL set  -> Postgres (Neon / Supabase / Vercel Postgres). Use this on Vercel.
 * - otherwise         -> ./data/drip.json (or DATA_DIR). On Vercel that file is temporary.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DripDoc } from '../types.js';

export function emptyDoc(): DripDoc {
  return { settings: { name: 'My Business' }, leads: [], campaigns: [], messages: [] };
}

export interface Store {
  kind: 'postgres' | 'file';
  persistent: boolean;
  read(): Promise<DripDoc>;
  /** Run fn on the current document and save the result atomically. Returns fn's return value. */
  mutate<T>(fn: (doc: DripDoc) => T): Promise<T>;
}

class FileStore implements Store {
  kind = 'file' as const;
  private file: string;
  private cache: DripDoc | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string, public persistent: boolean) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'drip.json');
  }

  private load(): DripDoc {
    if (!this.cache) {
      try {
        this.cache = { ...emptyDoc(), ...(JSON.parse(fs.readFileSync(this.file, 'utf8')) as DripDoc) };
      } catch {
        this.cache = emptyDoc();
      }
    }
    return this.cache;
  }

  async read() {
    await this.chain;
    return structuredClone(this.load());
  }

  mutate<T>(fn: (doc: DripDoc) => T): Promise<T> {
    const run = async () => {
      const doc = structuredClone(this.load());
      const out = fn(doc);
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(doc));
      await fs.promises.rename(tmp, this.file);
      this.cache = doc;
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

type PgClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; release: () => void };
type PgPool = PgClient & { connect: () => Promise<PgClient> };

class PgStore implements Store {
  kind = 'postgres' as const;
  persistent = true;
  private ready: Promise<void>;

  constructor(private pool: PgPool) {
    this.ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS drip_doc (id text PRIMARY KEY, doc jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      await pool.query(`INSERT INTO drip_doc (id, doc) VALUES ('main', $1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(emptyDoc())]);
    })();
  }

  async read() {
    await this.ready;
    const rows = (await this.pool.query(`SELECT doc FROM drip_doc WHERE id = 'main'`)).rows;
    return { ...emptyDoc(), ...(rows[0]?.doc as DripDoc) };
  }

  async mutate<T>(fn: (doc: DripDoc) => T): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = (await client.query(`SELECT doc FROM drip_doc WHERE id = 'main' FOR UPDATE`)).rows;
      const doc = { ...emptyDoc(), ...(rows[0]?.doc as DripDoc) };
      const out = fn(doc);
      await client.query(`UPDATE drip_doc SET doc = $1, updated_at = now() WHERE id = 'main'`, [JSON.stringify(doc)]);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

let store: Promise<Store> | null = null;

export function getStore(): Promise<Store> {
  if (store) return store;
  store = (async () => {
    const url = process.env.DATABASE_URL;
    if (url) {
      const pg = await import('pg');
      const Pool = (pg.default ?? pg).Pool;
      const needsSsl = !/localhost|127\.0\.0\.1/.test(url) && !/sslmode=disable/.test(url);
      return new PgStore(new Pool({ connectionString: url, max: 3, ssl: needsSsl ? { rejectUnauthorized: false } : undefined }) as unknown as PgPool);
    }
    const onVercel = Boolean(process.env.VERCEL);
    const dir = process.env.DATA_DIR || (onVercel ? '/tmp/drip' : path.join(process.cwd(), 'data'));
    return new FileStore(dir, !onVercel);
  })();
  return store;
}

/** Tests only: forget the cached store so a new DATA_DIR is used. */
export function resetStoreForTests() {
  store = null;
}
