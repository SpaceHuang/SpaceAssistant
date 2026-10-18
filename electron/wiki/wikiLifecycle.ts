import { randomUUID } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createWikiFileStore } from './wikiFileStore'
import { withWikiWriteMutex } from './wikiWriteMutex'
import { WIKI_BOOTSTRAP_SEAL } from './wikiPaths'

export type WikiLifecycleState = 'initializing' | 'domain_ready' | 'domain_enabled' | 'recovery_required'
interface RootIdentity { dev: number; ino: number }
interface BootstrapSeal { formatVersion: 1; bootstrapId: string; rootIdentity: RootIdentity; initialization: 'empty' | 'existing-content'; stage: 'initialized' | 'domain_ready' | 'domain_enabled'; preflightHash?: string }
interface LifecycleFile { formatVersion: 1; bootstrapId: string; lifecycle: WikiLifecycleState; initialization: BootstrapSeal['initialization']; preflightHash?: string }
export interface WikiLifecycleSnapshot { lifecycle: WikiLifecycleState; initialization?: BootstrapSeal['initialization']; preflightHash?: string; reason?: string }

export function createWikiLifecycleController(wikiRoot: string) {
  const root = path.resolve(wikiRoot)
  const store = createWikiFileStore(root)
  const lock = path.join(root, '.wiki-domain-lock')
  return {
    initialize(options: { fresh?: boolean } = {}): Promise<WikiLifecycleSnapshot> {
      return withWikiWriteMutex(lock, () => initialize(options))
    },
    read(): Promise<WikiLifecycleSnapshot> { return readSnapshot() },
    completeInitialization(preflightHash: string): Promise<void> {
      return withWikiWriteMutex(lock, async () => {
        const snapshot = await readSnapshot()
        if (snapshot.lifecycle !== 'initializing' || !preflightHash) throw new Error('wiki-lifecycle-invalid-transition')
        const seal = await readSeal()
        if (!seal) throw new Error('wiki-lifecycle-recovery-required')
        seal.stage = 'domain_ready'
        seal.preflightHash = preflightHash
        await writeSeal(seal)
        await store.write('.wiki-service/state.json', json({ formatVersion: 1, bootstrapId: seal.bootstrapId, lifecycle: 'domain_ready', initialization: seal.initialization, preflightHash } satisfies LifecycleFile))
      })
    },
    enable(): Promise<void> {
      return withWikiWriteMutex(lock, async () => {
        const snapshot = await readSnapshot()
        if (snapshot.lifecycle !== 'domain_ready') throw new Error('wiki-lifecycle-invalid-transition')
        const seal = await readSeal()
        if (!seal) throw new Error('wiki-lifecycle-recovery-required')
        seal.stage = 'domain_enabled'
        await writeSeal(seal)
        await store.write('.wiki-service/state.json', json({ formatVersion: 1, bootstrapId: seal.bootstrapId, lifecycle: 'domain_enabled', initialization: seal.initialization, ...(seal.preflightHash ? { preflightHash: seal.preflightHash } : {}) } satisfies LifecycleFile))
      })
    },
    markRecoveryRequired(): Promise<void> {
      return withWikiWriteMutex(lock, async () => {
        const seal = await readSeal()
        if (!seal) throw new Error('wiki-bootstrap-seal-unavailable')
        await store.write('.wiki-service/state.json', json({ formatVersion: 1, bootstrapId: seal.bootstrapId, lifecycle: 'recovery_required', initialization: seal.initialization } satisfies LifecycleFile))
      })
    },
  }

  async function initialize(options: { fresh?: boolean } = {}): Promise<WikiLifecycleSnapshot> {
    const sealExists = await exists(WIKI_BOOTSTRAP_SEAL)
    const stateExists = await exists('.wiki-service/state.json')
    if (sealExists || stateExists) return readSnapshot()
    const identity = await getRootIdentity(root)
    // Only the trusted initializer may mark its newly created root as empty. Existing roots
    // with partial content still require preflight, even when the standard files are absent.
    const initialization = options.fresh ? 'empty' : await hasExistingWikiContent(root) ? 'existing-content' : 'empty'
    const seal: BootstrapSeal = { formatVersion: 1, bootstrapId: randomUUID(), rootIdentity: identity, initialization, stage: initialization === 'empty' ? 'domain_ready' : 'initialized' }
    await writeSeal(seal)
    const lifecycle = initialization === 'empty' ? 'domain_ready' : 'initializing'
    await store.write('.wiki-service/state.json', json({ formatVersion: 1, bootstrapId: seal.bootstrapId, lifecycle, initialization } satisfies LifecycleFile))
    return { lifecycle, initialization }
  }

  async function readSnapshot(): Promise<WikiLifecycleSnapshot> {
    const [seal, state] = await Promise.all([readSeal(), readState()])
    if (!seal || !state) return { lifecycle: 'recovery_required', reason: 'bootstrap-control-missing-or-invalid' }
    if (state.lifecycle === 'recovery_required') return { lifecycle: 'recovery_required', reason: 'lifecycle-marked-for-recovery' }
    const actualIdentity = await getRootIdentity(root)
    if (!sameIdentity(actualIdentity, seal.rootIdentity) || seal.bootstrapId !== state.bootstrapId || seal.initialization !== state.initialization || seal.stage !== lifecycleToStage(state.lifecycle) || (seal.preflightHash ?? '') !== (state.preflightHash ?? '')) {
      return { lifecycle: 'recovery_required', reason: 'bootstrap-control-mismatch' }
    }
    return { lifecycle: state.lifecycle, initialization: state.initialization, ...(state.preflightHash ? { preflightHash: state.preflightHash } : {}) }
  }

  async function readSeal(): Promise<BootstrapSeal | undefined> {
    try {
      const value = JSON.parse(await store.readText(WIKI_BOOTSTRAP_SEAL)) as BootstrapSeal
      if (value.formatVersion !== 1 || !value.bootstrapId || !value.rootIdentity || !['empty', 'existing-content'].includes(value.initialization) || !['initialized', 'domain_ready', 'domain_enabled'].includes(value.stage)) return undefined
      return value
    } catch { return undefined }
  }
  async function readState(): Promise<LifecycleFile | undefined> {
    try {
      const value = JSON.parse(await store.readText('.wiki-service/state.json')) as LifecycleFile
      if (value.formatVersion !== 1 || !value.bootstrapId || !['initializing', 'domain_ready', 'domain_enabled', 'recovery_required'].includes(value.lifecycle)) return undefined
      return value
    } catch { return undefined }
  }
  async function writeSeal(seal: BootstrapSeal): Promise<void> { await store.write(WIKI_BOOTSTRAP_SEAL, json(seal)) }
  async function exists(relativePath: string): Promise<boolean> { try { await store.read(relativePath); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
}

async function hasExistingWikiContent(root: string): Promise<boolean> {
  for (const name of ['SCHEMA.md', 'raw', 'wiki']) {
    try { await stat(path.join(root, name)); return true } catch { /* absent */ }
  }
  return false
}
async function getRootIdentity(root: string): Promise<RootIdentity> {
  const resolved = await realpath(root)
  const value = await stat(resolved)
  if (!value.isDirectory()) throw new Error('wiki-root-not-directory')
  return { dev: value.dev, ino: value.ino }
}
function lifecycleToStage(lifecycle: LifecycleFile['lifecycle']): BootstrapSeal['stage'] | undefined {
  if (lifecycle === 'recovery_required') return undefined
  return lifecycle === 'initializing' ? 'initialized' : lifecycle
}
function sameIdentity(a: RootIdentity, b: RootIdentity): boolean { return a.dev === b.dev && a.ino === b.ino }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
