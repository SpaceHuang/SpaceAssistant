#!/usr/bin/env node
/**
 * Electron probe: node:sqlite (DatabaseSync) under the full Electron main process.
 * Usage: npx electron scripts/probe-node-sqlite.mjs
 *
 * Must run as a real Electron app (app.whenReady), never under ELECTRON_RUN_AS_NODE.
 * Creates a temp file database, writes/reads a row, prints Electron/Node versions,
 * always quits; non-zero exitCode on failure.
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('[probe-node-sqlite] ELECTRON_RUN_AS_NODE must not be set')
  process.exit(1)
}

// 超时兜底（评审 P1）：CI 上 Electron 偶发卡在 whenReady() 之前（沙盒/浏览器初始化），
// 无超时会让 probe 作业挂到默认 job 超时。超时后打印诊断并立即失败退出。
const TIMEOUT_MS = Number(process.env.PROBE_NODE_SQLITE_TIMEOUT_MS ?? 60_000)
const watchdog = setTimeout(() => {
  console.error(
    `[probe-node-sqlite] timed out after ${TIMEOUT_MS}ms ` +
      `(electron=${process.versions.electron ?? 'n/a'} node=${process.versions.node} arch=${process.arch} platform=${process.platform})`
  )
  process.exit(1)
}, TIMEOUT_MS)

let dir
app
  .whenReady()
  .then(() => {
    console.log(`[probe-node-sqlite] electron=${process.versions.electron} node=${process.versions.node} arch=${process.arch} platform=${process.platform}`)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-node-sqlite-probe-'))
    const dbPath = path.join(dir, 'probe.db')
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    const info = db.prepare('INSERT INTO probe (value) VALUES (?)').run('hello')
    if (Number(info.lastInsertRowid) !== 1) throw new Error(`unexpected lastInsertRowid: ${info.lastInsertRowid}`)
    const row = db.prepare('SELECT value FROM probe WHERE id = ?').get(1)
    if (!row || row.value !== 'hello') throw new Error('unexpected query result')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    if (!fs.existsSync(dbPath)) throw new Error('database file was not created')
    console.log('[probe-node-sqlite] ok: file db write/read/checkpoint verified')
  })
  .catch((e) => {
    console.error('[probe-node-sqlite] failed:', e instanceof Error ? e.stack || e.message : e)
    process.exitCode = 1
  })
  .finally(() => {
    clearTimeout(watchdog)
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    app.quit()
  })
