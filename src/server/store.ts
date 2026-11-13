/**
 * Server storage.
 * - DATABASE_URL set  -> Postgres (Neon / Supabase / Vercel Postgres). Use this on Vercel.
 * - otherwise         -> a JSON file in DATA_DIR (default ./data). Fine locally and on a single Node server.
 *   On Vercel without DATABASE_URL the file lives in /tmp and is lost on every cold start.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DripData, SendResult } from './types.js';

export interface Store {
  kind: 'postgres' | 'file';
  persistent: boolean;
  getData(): Promise<{ data: DripData | null; updated_at: string | null }>;
  saveData(data: DripData): Promise<string>;
  /**
   * Send log. claimSend atomically records that the server is about to send a message and returns
   * false if it was already claimed, so a message is never sent twice (two cron runs, or a browser
   * that uploads an older copy still marked "scheduled").
   */
  claimSend(msgId: string): Promise<boolean>;
  setSendResult(result: SendResult): Promise<void>;
  listSendResults(): Promise<SendResult[]>;
}

/* ------------------------------ JSON file ------------------------------ */

interface FileShape {
  data: DripData | null;
  updated_at: string | null;
  sent: Record<string, SendResult>;
}

class FileStore implements Store {
  kind = 'file' as const;
  private file: string;
  private cache: FileShape | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string, public persistent: boolean) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'drip.json');
  }

  private load(): FileShape {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) as FileShape;
    } catch {
      this.cache = { data: null, updated_at: null, sent: {} };
    }
    this.cache.sent ??= {};
    return this.cache;
  }

  /** Serialise writes and write atomically (temp file + rename). */
  private write(mutate: (s: FileShape) => void): Promise<void> {
    const run = async () => {
      const s = this.load();
      mutate(s);
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(s));
      await fs.promises.rename(tmp, this.file);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async getData() {
    const s = this.load();
    return { data: s.data, updated_at: s.updated_at };
  }
  async saveData(data: DripData) {
    const now = new Date().toISOString();
    await this.write((s) => {
      s.data = data;
      s.updated_at = now;
    });
    return now;
  }
  async claimSend(msgId: string) {
    let claimed = false;
    await this.write((s) => {
      if (s.sent[msgId]) return;
      s.sent[msgId] = { id: msgId, status: 'sending', sent_via: 'api' };
      claimed = true;
    });
    return claimed;
  }
  async setSendResult(result: SendResult) {
    await this.write((s) => {
      s.sent[result.id] = result;
    });
  }
  async listSendResults() {
    return Object.values(this.load().sent);
  }
}

/* ------------------------------ Postgres ------------------------------- */

type PgPool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

class PgStore implements Store {
  kind = 'postgres' as const;
  persistent = true;
  private ready: Promise<void>;

  constructor(private pool: PgPool) {
    this.ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS drip_data (
        id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS drip_sent (
        msg_id text PRIMARY KEY, result jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    })();
  }

  private async q(sql: string, params: unknown[] = []) {
    await this.ready;
    return (await this.pool.query(sql, params)).rows;
  }

  async getData() {
    const rows = await this.q("SELECT data, updated_at FROM drip_data WHERE id = 'main'");
    const u = rows[0]?.updated_at;
    return { data: (rows[0]?.data as DripData | undefined) ?? null, updated_at: u instanceof Date ? u.toISOString() : u ? String(u) : null };
  }
  async saveData(data: DripData) {
    const rows = await this.q(
      `INSERT INTO drip_data (id, data, updated_at) VALUES ('main', $1, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING updated_at`,
      [JSON.stringify(data)],
    );
    const u = rows[0]?.updated_at;
    return u instanceof Date ? u.toISOString() : new Date().toISOString();
  }
  async claimSend(msgId: string) {
    const rows = await this.q(
      `INSERT INTO drip_sent (msg_id, result) VALUES ($1, $2) ON CONFLICT (msg_id) DO NOTHING RETURNING msg_id`,
      [msgId, JSON.stringify({ id: msgId, status: 'sending', sent_via: 'api' })],
    );
    return rows.length === 1;
  }
  async setSendResult(result: SendResult) {
    await this.q(
      `INSERT INTO drip_sent (msg_id, result) VALUES ($1, $2)
       ON CONFLICT (msg_id) DO UPDATE SET result = EXCLUDED.result, updated_at = now()`,
      [result.id, JSON.stringify(result)],
    );
  }
  async listSendResults() {
    return (await this.q('SELECT result FROM drip_sent')).map((r) => r.result as SendResult);
  }
}

/* ------------------------------- factory ------------------------------- */

let store: Promise<Store> | null = null;

export function getStore(): Promise<Store> {
  if (store) return store;
  store = (async () => {
    const url = process.env.DATABASE_URL;
    if (url) {
      const pg = await import('pg');
      const Pool = (pg.default ?? pg).Pool;
      const needsSsl = !/localhost|127\.0\.0\.1/.test(url) && !/sslmode=disable/.test(url);
      const pool = new Pool({ connectionString: url, max: 3, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
      return new PgStore(pool as unknown as PgPool);
    }
    const onVercel = Boolean(process.env.VERCEL);
    const dir = process.env.DATA_DIR || (onVercel ? '/tmp/drip' : path.join(process.cwd(), 'data'));
    return new FileStore(dir, !onVercel);
  })();
  return store;
}
