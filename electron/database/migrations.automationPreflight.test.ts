import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'

function v102(databasePath = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schema_version','102');
    CREATE TABLE automation_tasks (
      id TEXT PRIMARY KEY NOT NULL, work_dir TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER, created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE automation_task_runs (
      id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
      client_id TEXT NOT NULL, scheduled_for INTEGER NOT NULL
    );
    INSERT INTO automation_tasks(id,work_dir,next_run_at) VALUES
      ('legacy','/old/root',1234), ('empty',NULL,5678);
    INSERT INTO automation_task_runs(id,task_id,status,client_id,scheduled_for) VALUES
      ('queued','legacy','queued','legacy:1',1), ('running','legacy','running','legacy:2',2);
  `)
  return db
}

describe('migration v103 automation preflight', () => {
  it('preserves legacy roots as v0, creates recovery cursor, and marks active runs legacy-unknown', () => {
    const db = v102()
    runMigrations(db)
    expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '103' })
    expect(db.prepare('SELECT id,work_dirs_json,preflight_version,target_bindings_json FROM automation_tasks ORDER BY id').all()).toEqual([
      { id: 'empty', work_dirs_json: '[]', preflight_version: 0, target_bindings_json: null },
      { id: 'legacy', work_dirs_json: '["/old/root"]', preflight_version: 0, target_bindings_json: null },
    ])
    expect(db.prepare('SELECT id,run_phase FROM automation_task_runs ORDER BY id').all()).toEqual([
      { id: 'queued', run_phase: 'legacy-unknown' }, { id: 'running', run_phase: 'legacy-unknown' },
    ])
    expect(db.prepare('SELECT task_id,recovery_cursor_at FROM automation_task_recovery_state ORDER BY task_id').all()).toEqual([
      { task_id: 'empty', recovery_cursor_at: 5678 }, { task_id: 'legacy', recovery_cursor_at: 1234 },
    ])
    runMigrations(db)
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_task_recovery_state').get()).toEqual({ count: 2 })
    db.close()
  })
})

it('rejects a higher-version database and rolls back a failed v103 migration atomically', () => {
  const db = v102()
  db.prepare("UPDATE schema_meta SET value='104' WHERE key='schema_version'").run()
  expect(() => runMigrations(db)).toThrow(/高于当前应用支持的版本/)
  db.prepare("UPDATE schema_meta SET value='102' WHERE key='schema_version'").run()
  db.exec(`CREATE TRIGGER reject_task_migration BEFORE UPDATE OF work_dirs_json ON automation_tasks
    WHEN OLD.id='legacy' BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;`)
  expect(() => runMigrations(db)).toThrow(/injected migration failure/)
  expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '102' })
  expect((db.prepare('PRAGMA table_info(automation_tasks)').all() as Array<{ name: string }>).some((column) => column.name === 'work_dirs_json')).toBe(false)
  db.close()
})

it('restores a pre-upgrade backup and can upgrade it again without losing legacy task data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-preflight-v103-'))
  const originalPath = path.join(directory, 'before.sqlite')
  const backupPath = path.join(directory, 'backup.sqlite')
  const restoredPath = path.join(directory, 'restored.sqlite')
  try {
    const original = v102(originalPath)
    original.close()
    fs.copyFileSync(originalPath, backupPath)

    const upgraded = new DatabaseSync(originalPath)
    runMigrations(upgraded)
    upgraded.close()

    fs.copyFileSync(backupPath, restoredPath)
    const restored = new DatabaseSync(restoredPath)
    expect(restored.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '102' })
    expect(restored.prepare("SELECT work_dir FROM automation_tasks WHERE id='legacy'").get()).toEqual({ work_dir: '/old/root' })
    runMigrations(restored)
    expect(restored.prepare("SELECT work_dirs_json FROM automation_tasks WHERE id='legacy'").get()).toEqual({ work_dirs_json: '["/old/root"]' })
    expect(restored.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    restored.close()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
