import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { openDatabase } from '../electron/database'
import { appendMessage, createSession, setConfigValue } from '../electron/database/operations'
import { getDbConnection } from '../electron/database/sqliteStore'
import { appendSqliteAgentHistoryBatchInTransaction } from '../electron/database/agentHistoryStorage'
import type { HistoryEvent } from '../packages/agent-sdk/src/history'

const [sourcePath, outputPath] = process.argv.slice(2)
if (!sourcePath || !outputPath) throw new Error('Usage: node --import tsx scripts/create-session-storage-cleanup-fixture.ts <profile-db> <output-db>')

const source = path.resolve(sourcePath)
const output = path.resolve(outputPath)
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.copyFileSync(source, output)

const db = openDatabase(output)
try {
  const conn = getDbConnection(db)
  setConfigValue(db, 'sessionStorage.syntheticProfileFixture', 'synthetic-session-storage-cleanup-v1')
  const roots = [path.join(path.dirname(output), 'workspace-primary'), path.join(path.dirname(output), 'workspace-profile')]
  setConfigValue(db, 'config.workDir', roots[0]!)
  setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'synthetic-profile', path: roots[1] }]))
  setConfigValue(db, 'retention.sessionEvent.maxSessions', '100')
  setConfigValue(db, 'retention.spill.degradableDays', '30')
  const now = Date.now()

  const createIndexedDirectories = (root: string, count: number, offset: number) => {
    const sessionsRoot = path.join(root, 'sessions')
    fs.mkdirSync(sessionsRoot, { recursive: true })
    for (let i = 0; i < count; i += 1) {
      const directory = path.join(sessionsRoot, `synthetic-session-${offset + i + 1}`)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'events.index.json'), JSON.stringify({ lastAt: now - i * 1_000 }))
      fs.writeFileSync(path.join(directory, 'events.jsonl'), `synthetic-ledger-${offset + i + 1}\n`.repeat(i % 7 + 1))
    }
  }
  createIndexedDirectories(roots[0]!, 102, 0)
  createIndexedDirectories(roots[1]!, 3, 10_000)
  const unindexed = path.join(roots[0]!, 'sessions', 'synthetic-unindexed-backup')
  fs.mkdirSync(unindexed, { recursive: true })
  fs.writeFileSync(path.join(unindexed, 'backup.jsonl'), 'synthetic-unindexed-ledger\n')

  const candidateSession = createSession(db, { name: 'Synthetic cleanup candidate', model: 'synthetic' })
  const candidateMessage = { id: 'synthetic-cleanup-identity-message', role: 'user' as const,
    content: 'synthetic canonical identity body '.repeat(13_900), timestamp: now }
  appendMessage(db, { ...candidateMessage, sessionId: candidateSession.id, status: 'sent' })
  const candidateEvent: HistoryEvent = { invocationId: 'synthetic-cleanup-candidate-invocation',
    turnId: 'synthetic-cleanup-candidate-turn', sequence: 1, schemaVersion: 1,
    eventId: 'synthetic-cleanup-candidate-context', idempotencyKey: 'synthetic-cleanup-candidate-context',
    kind: 'invocation-context-committed', payload: { messages: [candidateMessage] } }
  appendSqliteAgentHistoryBatchInTransaction(conn, [candidateEvent], 0, { sessionId: candidateSession.id })

  const spillRoot = path.join(path.dirname(output), 'spill')
  fs.mkdirSync(spillRoot, { recursive: true })
  const descriptors = [
    { version: 1, kind: 'degradable', locator: '00000000-0000-4000-8000-000000000101.spill', content: 'expired-degradable-synthetic-spill' },
    { version: 1, kind: 'source-of-truth', locator: '00000000-0000-4000-8000-000000000102.spill', content: 'required-source-synthetic-spill' }
  ].map(({ content, ...descriptor }) => {
    const bytes = Buffer.from(content)
    fs.writeFileSync(path.join(spillRoot, descriptor.locator), bytes)
    return { ...descriptor, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: 1, head: content, tail: content }
  })
  const orphanLocator = '00000000-0000-4000-8000-000000000103.spill'
  fs.writeFileSync(path.join(spillRoot, orphanLocator), 'unreferenced-synthetic-spill')
  const spillSession = conn.prepare(`SELECT s.id,COALESCE(MAX(t.version),0) AS version FROM sessions s
    LEFT JOIN session_transcript_entries t ON t.session_id=s.id GROUP BY s.id ORDER BY s.created_at LIMIT 1`).get() as
    { id: string; version: number } | undefined
  if (!spillSession) throw new Error('profile fixture has no session for synthetic spill references')
  conn.prepare(`INSERT INTO session_transcript_entries
    (session_id,turn_id,base_version,version,outcome,messages_json,created_at) VALUES(?,?,?,?,'completed',?,?)`)
    .run(spillSession.id, 'synthetic-cleanup-spill-turn', spillSession.version, spillSession.version + 1,
      JSON.stringify({ spillReferences: descriptors }), now)

  process.stdout.write(`${JSON.stringify({ fixture: 'synthetic-session-storage-cleanup-v1', containsUserData: false,
    schemaVersion: conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    workspaceRoots: 2, indexedSessionDirectories: 105, unindexedSessionDirectories: 1,
    identityBodyCandidateMessages: 1, spillDescriptors: descriptors.length, orphanSpillFiles: 1 }, null, 2)}\n`)
} finally {
  db.close()
}
