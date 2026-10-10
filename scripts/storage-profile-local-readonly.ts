import { app } from 'electron'
import path from 'node:path'
import { getDefaultDbPath } from '../dist-electron/electron/database/index.js'
import { sampleLocalStorageReadonly } from '../electron/storageProfile/localReadonlySample'
import { runStorageProfileWorker } from '../electron/storageProfile/storageProfileWorkerClient'

const dryRun = process.argv.includes('--dry-run')
app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const result = await sampleLocalStorageReadonly({ candidates: [getDefaultDbPath(userData)], dryRun,
    runOverview: (dbPath) => runStorageProfileWorker({ type: 'overview', dbPath }, { workerPath: path.resolve('dist-electron/electron/storageProfile/storageProfileWorker.js') }) })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.status === 'skipped') process.exitCode = 0
}).catch((error) => {
  process.stderr.write(`[storage-profile:local-readonly] failed: ${error instanceof Error ? error.name : 'unknown'}\n`)
  process.exitCode = 1
}).finally(() => app.quit())
