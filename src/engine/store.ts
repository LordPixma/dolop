// Per-user migration state, persisted in the Durable Object's SQLite storage.
//
// Key conventions:
//   phase:<workload>            current phase within a workload (reset each pass)
//   state:<workload>:<key>      transient pass state (reset each pass)
//   cursor:<workload>:<key>     persistent cursors — delta links — survive passes
//   sys:<key>                   orchestrator bookkeeping (current pass, indexes…)
// The idmap table (source item id → destination item id) survives passes and is
// what makes pre-stage → full → delta sequences idempotent.

export class EngineStore {
  constructor(private sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS idmap (
         workload TEXT NOT NULL, kind TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
         PRIMARY KEY (workload, kind, src)
       )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS work (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         workload TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
       )`
    );
  }

  // -- generic kv ------------------------------------------------------------

  getRaw(key: string): string | null {
    const rows = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', key).toArray();
    return rows[0]?.v ?? null;
  }

  setRaw(key: string, value: string): void {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, value);
  }

  delRaw(key: string): void {
    this.sql.exec('DELETE FROM kv WHERE k = ?', key);
  }

  getJson<T>(key: string): T | null {
    const raw = this.getRaw(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    this.setRaw(key, JSON.stringify(value));
  }

  // -- engine-facing helpers ---------------------------------------------------

  getPhase(workload: string): string | null {
    return this.getRaw(`phase:${workload}`);
  }

  setPhase(workload: string, phase: string): void {
    this.setRaw(`phase:${workload}`, phase);
  }

  getState<T>(workload: string, key: string): T | null {
    return this.getJson<T>(`state:${workload}:${key}`);
  }

  setState(workload: string, key: string, value: unknown): void {
    this.setJson(`state:${workload}:${key}`, value);
  }

  delState(workload: string, key: string): void {
    this.delRaw(`state:${workload}:${key}`);
  }

  getCursor(workload: string, key: string): string | null {
    return this.getRaw(`cursor:${workload}:${key}`);
  }

  setCursor(workload: string, key: string, value: string): void {
    this.setRaw(`cursor:${workload}:${key}`, value);
  }

  delCursor(workload: string, key: string): void {
    this.delRaw(`cursor:${workload}:${key}`);
  }

  // -- id map ------------------------------------------------------------------

  mapGet(workload: string, kind: string, src: string): string | null {
    const rows = this.sql
      .exec<{ dst: string }>('SELECT dst FROM idmap WHERE workload = ? AND kind = ? AND src = ?', workload, kind, src)
      .toArray();
    return rows[0]?.dst ?? null;
  }

  mapPut(workload: string, kind: string, src: string, dst: string): void {
    this.sql.exec(
      `INSERT INTO idmap (workload, kind, src, dst) VALUES (?, ?, ?, ?)
       ON CONFLICT(workload, kind, src) DO UPDATE SET dst = excluded.dst`,
      workload,
      kind,
      src,
      dst
    );
  }

  mapCount(workload: string, kind: string): number {
    const rows = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM idmap WHERE workload = ? AND kind = ?', workload, kind)
      .toArray();
    return rows[0]?.n ?? 0;
  }

  // -- work queue ----------------------------------------------------------------

  pushWork(workload: string, kind: string, payload: unknown): void {
    this.sql.exec(
      'INSERT INTO work (workload, kind, payload) VALUES (?, ?, ?)',
      workload,
      kind,
      JSON.stringify(payload)
    );
  }

  peekWork<T>(workload: string, kind?: string): { id: number; kind: string; payload: T } | null {
    const rows = kind
      ? this.sql
          .exec<{ id: number; kind: string; payload: string }>(
            'SELECT id, kind, payload FROM work WHERE workload = ? AND kind = ? ORDER BY id LIMIT 1',
            workload,
            kind
          )
          .toArray()
      : this.sql
          .exec<{ id: number; kind: string; payload: string }>(
            'SELECT id, kind, payload FROM work WHERE workload = ? ORDER BY id LIMIT 1',
            workload
          )
          .toArray();
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, kind: row.kind, payload: JSON.parse(row.payload) as T };
  }

  popWork(id: number): void {
    this.sql.exec('DELETE FROM work WHERE id = ?', id);
  }

  updateWork(id: number, payload: unknown): void {
    this.sql.exec('UPDATE work SET payload = ? WHERE id = ?', JSON.stringify(payload), id);
  }

  workCount(workload: string, kind?: string): number {
    const rows = kind
      ? this.sql
          .exec<{ n: number }>('SELECT COUNT(*) AS n FROM work WHERE workload = ? AND kind = ?', workload, kind)
          .toArray()
      : this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM work WHERE workload = ?', workload).toArray();
    return rows[0]?.n ?? 0;
  }

  // -- pass lifecycle ---------------------------------------------------------------

  /** Clear per-pass state while keeping idmap + delta cursors (incremental sync). */
  resetPass(): void {
    this.sql.exec(`DELETE FROM kv WHERE k LIKE 'phase:%' OR k LIKE 'state:%'`);
    // Queued attachment repairs survive into the next pass so they self-heal.
    this.sql.exec(`DELETE FROM work WHERE kind <> 'attretry'`);
  }

  /**
   * Erase everything — id map, delta cursors, pass state. Used when a user's
   * destination mailbox changes: stale mappings would otherwise make later
   * passes skip items that were never copied to the new destination.
   */
  wipe(): void {
    this.sql.exec('DELETE FROM kv');
    this.sql.exec('DELETE FROM idmap');
    this.sql.exec('DELETE FROM work');
  }
}
