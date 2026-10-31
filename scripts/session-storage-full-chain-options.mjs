export function createFixtureDefinition(args) {
  const value = (name, fallback) => {
    const equalsPrefix = `${name}=`
    const equals = args.filter((arg) => arg.startsWith(equalsPrefix))
    const index = args.indexOf(name)
    if (equals.length + Number(index >= 0) > 1) throw new Error(`duplicate option: ${name}`)
    if (equals.length) return equals[0].slice(equalsPrefix.length)
    if (index >= 0) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`missing value for ${name}`)
      return args[index + 1]
    }
    return fallback
  }
  const quick = args.includes('--quick')
  const seed = Number(value('--seed', 20261031))
  const sampleValue = value('--samples', quick ? 1 : 30)
  const samples = Number(sampleValue)
  const runnerTimeoutMs = Number(value('--timeout-ms', 600_000))
  const only = value('--only', undefined)
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be an unsigned 32-bit integer')
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 30) throw new Error('samples must be an integer from 1 to 30')
  if (!Number.isSafeInteger(runnerTimeoutMs) || runnerTimeoutMs < 10_000 || runnerTimeoutMs > 3_600_000) throw new Error('timeout must be from 10000 to 3600000 ms')
  const counts = quick ? { events: [100], pending: [1], turns: [100], tools: [10], hugeTools: 1, coldHistory: [], contextSummary: [1000] } :
    { events: [100, 400, 800], pending: [1, 16], turns: [100, 1000], tools: [10, 100, 1000], hugeTools: 100, coldHistory: [1, 10, 100], contextSummary: [100, 1000] }
  const rng = (() => { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 0x100000000) })()
  const sizes = { eventBytes: 4096, messageBytes: 4096, toolBytes: 4096, hugeToolBytes: 1024 * 1024 }
  let scenarios = [
    ...counts.events.flatMap((n) => counts.pending.map((pendingCount) => ({ kind: 'events', scenarioId: `events-${n}-pending-${pendingCount}`, count: n, pendingCount,
      batchSize: 10, bodyBytes: n * sizes.eventBytes }))),
    ...counts.turns.map((n) => ({ kind: 'turns', scenarioId: `turns-${n}`, count: n, bodyBytes: n * sizes.messageBytes, pageSize: 20 })),
    ...counts.tools.map((n) => ({ kind: 'tools', scenarioId: `tools-${n}`, count: n, bodyBytes: n * sizes.toolBytes })),
    { kind: 'large-tool-results', scenarioId: `large-tool-results-${counts.hugeTools}`, count: counts.hugeTools, batchSize: 10, bodyBytes: counts.hugeTools * sizes.hugeToolBytes },
    ...counts.coldHistory.map((mib) => ({ kind: 'cold-history', scenarioId: `cold-history-${mib}`, count: mib, bodyBytes: mib * 1024 * 1024 })),
    ...counts.contextSummary.map((count) => ({ kind: 'context-summary', scenarioId: `context-summary-${count}`, count, bodyBytes: 1024 }))
  ]
  if (only) scenarios = scenarios.filter(({ kind }) => kind === only)
  if (!scenarios.length) throw new Error(`unknown or empty scenario selection: ${only}`)
  return {
    runnerTimeoutMs,
    fixture: { schemaVersion: 1, seed, rngProbe: rng(), cacheMode: 'process-cold; OS page cache not controlled', checkpoints: 'disabled', scenarios,
      samples, fixtureVersion: 'session-storage-full-chain-v1' }
  }
}
