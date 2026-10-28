import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createSession } from '../electron/database/operations'
import { getDbConnection, openDatabase } from '../electron/database'
import { ensureSessionLedgerAdmission, type SessionLedgerLifecycleDependencies } from '../electron/sessionLedgerLifecycle'
import { ensureLegacyLedgerReadiness } from '../electron/sessionLedgerReadiness'
import { measureSerialAdmission } from '../electron/sessionLedgerAdmissionBenchmark'

function readOptions(argv: readonly string[]): { warmup: number; samples: number; outputPath?: string } {
  const values = new Map(argv.filter((arg) => arg.startsWith('--')).map((arg) => {
    const separator = arg.indexOf('=')
    return separator < 0 ? [arg.slice(2), ''] as const : [arg.slice(2, separator), arg.slice(separator + 1)] as const
  }))
  const warmup = Number(values.get('warmup') ?? 50)
  const samples = Number(values.get('samples') ?? 250)
  if (!Number.isSafeInteger(warmup) || warmup < 0 || !Number.isSafeInteger(samples) || samples < 200) {
    throw new Error('SESSION_LEDGER_BENCHMARK_SAMPLE_COUNT_INVALID')
  }
  return { warmup, samples, ...(values.get('out') ? { outputPath: values.get('out') } : {}) }
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2))
  const db = openDatabase(':memory:')
  try {
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'session-ledger-admission-benchmark', model: 'benchmark' })
    const location = { workDir: '/tmp/session-ledger-admission-benchmark', sessionId: session.id, createdAt: session.createdAt }
    const readiness = ensureLegacyLedgerReadiness(conn, location, session.generation)
    conn.prepare(`UPDATE session_ledger_projection_state SET state='ready',canonical_watermark='benchmark:1',
      ledger_generation=1,owner_reconciled_process_generation=1 WHERE ledger_location_key=?`).run(readiness.ledgerLocationKey)
    const unusedDependencies: SessionLedgerLifecycleDependencies = {
      fileExists: async () => { throw new Error('BENCHMARK_UNEXPECTED_FILE_IO') },
      readProof: async () => { throw new Error('BENCHMARK_UNEXPECTED_FILE_IO') },
      bootstrap: async () => { throw new Error('BENCHMARK_UNEXPECTED_LIFECYCLE') },
      baseline: async () => { throw new Error('BENCHMARK_UNEXPECTED_LIFECYCLE') },
      applyTarget: async () => { throw new Error('BENCHMARK_UNEXPECTED_LIFECYCLE') }
    }
    const measured = await measureSerialAdmission(() => ensureSessionLedgerAdmission({ conn, location,
      sessionGeneration: session.generation, processGeneration: 1, dependencies: unusedDependencies }), options)
    const report = {
      benchmark: 'session-ledger-admission',
      entryPoint: 'ensureSessionLedgerAdmission',
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      fixture: { database: 'in-memory SQLite', sessions: 1, readinessRows: 1, pendingOutboxRows: 0,
        canonicalHistoryEvents: 0, processGeneration: 1 },
      execution: { serial: true, processCount: 1, warmupCount: measured.warmupCount,
        sampleCount: measured.sampleCount, quantile: measured.quantile, budgetP95Ms: 10 },
      p95Ms: measured.p95Ms,
      passed: measured.sampleCount >= 200 && measured.p95Ms <= 10,
      durationsMs: measured.durationsMs
    }
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if (options.outputPath) await fs.writeFile(options.outputPath, serialized, 'utf8')
    process.stdout.write(serialized)
    if (!report.passed) process.exitCode = 1
  } finally {
    db.close()
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
