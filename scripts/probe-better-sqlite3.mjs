#!/usr/bin/env node
/**
 * Electron probe: require('better-sqlite3') under Electron runtime.
 * Usage: electron scripts/probe-better-sqlite3.mjs
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
try {
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);')
  const row = db.prepare('SELECT id FROM t').get()
  if (!row || row.id !== 1) throw new Error('unexpected query result')
  db.close()
  console.log('[probe-better-sqlite3] ok')
  process.exit(0)
} catch (e) {
  console.error('[probe-better-sqlite3] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
}
