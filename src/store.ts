import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defaults, settingsSchema, type Settings, type Run, type Step, type ToolResult } from './contracts.ts';
import type { Action } from './tools.ts';

export class Store {
  private db: DatabaseSync;
  private recentCache?: Run[];
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chatgpt_profiles (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, command TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_metadata (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), description TEXT, routine TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS trace (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        run_id TEXT NOT NULL REFERENCES runs(id), position INTEGER NOT NULL, label TEXT NOT NULL, tool TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT, error TEXT, PRIMARY KEY(run_id, position)
      );
    `);
    this.transaction(() => {
      this.db.exec(`
        UPDATE steps SET status = 'failed', error = 'Interrupted. The action may have happened.'
          WHERE status = 'running' AND run_id IN (SELECT id FROM runs WHERE status = 'running');
        UPDATE steps SET status = 'skipped'
          WHERE status = 'queued' AND run_id IN (SELECT id FROM runs WHERE status = 'running');
        UPDATE runs SET status = 'interrupted', message = 'Rove closed during execution. Check what opened before running again.'
          WHERE status = 'running';
      `);
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  settings(): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id = 1').get();
    if (!row) return defaults;
    // Older profiles may still contain example configuration. Read only current preferences.
    const previous = JSON.parse(String(row.value));
    return settingsSchema.parse({
      shortcut: previous.shortcut, showCompanion: previous.showCompanion,
      animateCompanion: previous.animateCompanion, model: previous.model,
      connectionMode: previous.connectionMode, chatgptModel: previous.chatgptModel,
      desktopAccess: previous.desktopAccess,
      quietMode: previous.quietMode, restingCorner: previous.restingCorner, restingPosition: previous.restingPosition, routines: previous.routines,
    });
  }

  save(settings: Settings) {
    this.db.prepare('INSERT INTO settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
      .run(JSON.stringify(settings));
  }

  start(command: string, status: Run['status'], message: string, actions: Action[] = [], description?: string, routine?: string) {
    this.recentCache = undefined;
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?)').run(id, command, new Date().toISOString(), status, message);
      this.db.prepare('INSERT INTO run_metadata VALUES (?, ?, ?, ?)')
        .run(id, description ?? null, routine ?? null, status === 'running' ? null : new Date().toISOString());
      const insert = this.db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, 'queued', NULL, NULL)");
      actions.forEach((action, index) => insert.run(id, index, action.label, action.tool));
    });
    return id;
  }

  metadata(key: string, value?: string): string | undefined {
    if (value !== undefined) this.db.prepare('INSERT INTO app_metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    const row = this.db.prepare('SELECT value FROM app_metadata WHERE key = ?').get(key);
    return row ? String(row.value) : undefined;
  }

  authProfiles() {
    return this.db.prepare('SELECT id, encrypted FROM chatgpt_profiles ORDER BY rowid').all().map(row => ({
      id: String(row.id), encrypted: Buffer.from(row.encrypted as Uint8Array),
    }));
  }

  saveAuthProfile(id: string, encrypted: Buffer) {
    this.db.prepare('INSERT INTO chatgpt_profiles VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET encrypted = excluded.encrypted').run(id, encrypted);
  }

  useRoutine(id: string, routine: string) {
    this.recentCache = undefined;
    this.db.prepare('UPDATE run_metadata SET routine = ? WHERE run_id = ?').run(routine, id);
  }

  hasCredential() {
    return Boolean(this.db.prepare('SELECT 1 FROM credentials WHERE id = 1').get());
  }

  credential(): Buffer | undefined {
    const row = this.db.prepare('SELECT encrypted FROM credentials WHERE id = 1').get();
    return row?.encrypted instanceof Uint8Array ? Buffer.from(row.encrypted) : undefined;
  }

  saveCredential(encrypted?: Buffer) {
    if (encrypted) this.db.prepare('INSERT OR REPLACE INTO credentials VALUES (1, ?)').run(encrypted);
    else this.db.prepare('DELETE FROM credentials WHERE id = 1').run();
  }

  trace(id: string, kind: string, data: unknown) {
    this.db.prepare('INSERT INTO trace (run_id, at, kind, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), kind, JSON.stringify(data));
  }

  readTrace(id: string, offset: number) {
    return this.db.prepare('SELECT at, kind, substr(data, 1, 650) AS excerpt FROM trace WHERE run_id = ? ORDER BY trace.id LIMIT 4 OFFSET ?')
      .all(id, offset);
  }

  saveEvidence(id: string, kind: 'text' | 'image', data: Buffer): number {
    return Number(this.db.prepare('INSERT INTO evidence (run_id, kind, data) VALUES (?, ?, ?)').run(id, kind, data).lastInsertRowid);
  }

  evidence(id: string, ref: number) {
    const row = this.db.prepare('SELECT kind, data FROM evidence WHERE id = ? AND run_id = ?').get(ref, id);
    if (!row || !(row.data instanceof Uint8Array)) return undefined;
    return { kind: row.kind, data: Buffer.from(row.data) };
  }

  addStep(id: string, label: string, tool: string) {
    this.recentCache = undefined;
    const row = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM steps WHERE run_id = ?').get(id);
    const index = Number(row?.next);
    this.db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, 'running', NULL, NULL)").run(id, index, label, tool);
    return index;
  }

  updateStep(id: string, index: number, status: Step['status'], result?: ToolResult, error?: string) {
    this.recentCache = undefined;
    this.db.prepare('UPDATE steps SET status = ?, result = ?, error = ? WHERE run_id = ? AND position = ?')
      .run(status, result ? JSON.stringify(result) : null, error ?? null, id, index);
  }

  finish(id: string, status: Run['status'], message: string) {
    this.recentCache = undefined;
    this.transaction(() => {
      if (status === 'cancelled') {
        this.db.prepare("UPDATE steps SET status = 'skipped' WHERE run_id = ? AND status = 'queued'").run(id);
      }
      this.db.prepare('UPDATE runs SET status = ?, message = ? WHERE id = ?').run(status, message, id);
      this.db.prepare('UPDATE run_metadata SET finished_at = ? WHERE run_id = ?').run(new Date().toISOString(), id);
    });
  }

  recent(): Run[] {
    if (this.recentCache) return this.recentCache;
    const readSteps = this.db.prepare('SELECT label, tool, status, result, error FROM steps WHERE run_id = ? ORDER BY position');
    return this.recentCache = this.db.prepare('SELECT runs.*, description, routine, finished_at FROM runs LEFT JOIN run_metadata ON run_id = runs.id ORDER BY runs.rowid DESC LIMIT 20').all().map(row => ({
      id: String(row.id), command: String(row.command), createdAt: String(row.created_at),
      description: row.description ? String(row.description) : undefined,
      routine: row.routine ? String(row.routine) : undefined,
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
      status: row.status as Run['status'], message: String(row.message),
      steps: readSteps.all(row.id).map(step => ({
        label: String(step.label), tool: String(step.tool), status: step.status as Step['status'],
        result: step.result ? JSON.parse(String(step.result)) : undefined,
        error: step.error ? String(step.error) : undefined,
      })),
    }));
  }

  close() { this.db.close(); }
}
