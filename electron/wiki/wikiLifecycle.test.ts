import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiLifecycleController } from './wikiLifecycle'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function rootFixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-lifecycle-')); roots.push(root); return root }

describe('WikiLifecycleController', () => {
  it('seals an empty Wiki as domain_ready and makes lifecycle state durable', async () => {
    const root = await rootFixture()
    const lifecycle = createWikiLifecycleController(root)
    expect(await lifecycle.initialize()).toMatchObject({ lifecycle: 'domain_ready', initialization: 'empty' })
    const state = JSON.parse(await readFile(path.join(root, '.wiki-service/state.json'), 'utf8')) as { lifecycle: string }
    expect(state.lifecycle).toBe('domain_ready')
  })

  it('keeps existing Wiki content in initializing until preflight is explicitly completed', async () => {
    const root = await rootFixture()
    await mkdir(path.join(root, 'wiki'))
    await writeFile(path.join(root, 'SCHEMA.md'), 'legacy schema')
    const lifecycle = createWikiLifecycleController(root)
    expect(await lifecycle.initialize()).toMatchObject({ lifecycle: 'initializing', initialization: 'existing-content' })
    expect(await lifecycle.initialize()).toMatchObject({ lifecycle: 'initializing' })
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toBe('legacy schema')
    await lifecycle.completeInitialization('preflight-hash')
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'domain_ready', preflightHash: 'preflight-hash' })
  })

  it('holds the write barrier during migration and records a durable preflight binding', async () => {
    const root = await rootFixture()
    await mkdir(path.join(root, 'wiki'))
    await writeFile(path.join(root, 'SCHEMA.md'), 'legacy schema')
    const lifecycle = createWikiLifecycleController(root)
    await lifecycle.initialize()
    await lifecycle.beginMigration('preflight-hash', '123e4567-e89b-42d3-a456-426614174000')
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'initializing', preflightHash: 'preflight-hash' })
    await expect(lifecycle.enable()).rejects.toThrow('wiki-lifecycle-invalid-transition')
    await lifecycle.completeMigration('preflight-hash', '123e4567-e89b-42d3-a456-426614174000')
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'domain_ready', preflightHash: 'preflight-hash' })
  })

  it.each(['state-missing', 'seal-missing', 'state-corrupt', 'seal-mismatch'])('fails closed for %s without resetting Wiki files', async mode => {
    const root = await rootFixture()
    const lifecycle = createWikiLifecycleController(root)
    await lifecycle.initialize()
    if (mode === 'state-missing') await rm(path.join(root, '.wiki-service/state.json'))
    if (mode === 'seal-missing') await rm(path.join(root, '.wiki-service-bootstrap.json'))
    if (mode === 'state-corrupt') await writeFile(path.join(root, '.wiki-service/state.json'), '{bad')
    if (mode === 'seal-mismatch') await writeFile(path.join(root, '.wiki-service-bootstrap.json'), '{"formatVersion":1,"bootstrapId":"forged"}')
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'recovery_required' })
    expect(await lifecycle.initialize()).toMatchObject({ lifecycle: 'recovery_required' })
  })

  it('allows domain_enabled only after domain_ready and records the transition', async () => {
    const root = await rootFixture()
    const lifecycle = createWikiLifecycleController(root)
    await lifecycle.initialize()
    await lifecycle.enable()
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'domain_enabled' })
  })

  it('does not accept a copied seal and state after the Wiki root identity changes', async () => {
    const root = await rootFixture()
    const lifecycle = createWikiLifecycleController(root)
    await lifecycle.initialize()
    const movedRoot = `${root}-old`
    await rename(root, movedRoot)
    await mkdir(root)
    await cp(path.join(movedRoot, '.wiki-service-bootstrap.json'), path.join(root, '.wiki-service-bootstrap.json'))
    await mkdir(path.join(root, '.wiki-service'))
    await cp(path.join(movedRoot, '.wiki-service/state.json'), path.join(root, '.wiki-service/state.json'))
    expect(await createWikiLifecycleController(root).read()).toMatchObject({ lifecycle: 'recovery_required', reason: 'bootstrap-control-mismatch' })
  })
})
