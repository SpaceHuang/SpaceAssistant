import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWikiCommand } from '../../src/shared/outbound/wikiCommandService'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { importAllRawFromWorkDir, importRawFromWorkDir } from './wikiImport'
import { importWikiSourceForContext, readWikiSourceForContext } from './wikiDomainTools'
import { createWikiLifecycleController } from './wikiLifecycle'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function temp(prefix: string) { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(root); return fs.realpathSync(root) }

describe('Wiki command to sourceId integration', () => {
  it('routes /wiki ingest through the real shared import and reads its bound snapshot', async () => {
    const workDir = temp('wiki-route-work-')
    const userDataPath = temp('wiki-route-data-')
    fs.writeFileSync(path.join(workDir, 'note.md'), 'integration source')
    const wikiRoot = path.join(userDataPath, 'llm-wiki')
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const imported = await parseWikiCommand('/wiki ingest note.md', { manualActivated: [], manualDisabled: [] }, {
      wikiInit: vi.fn(),
      wikiStatus: vi.fn().mockResolvedValue({ rootPath: 'llm-wiki', initialized: true, pageCount: 0, rawCount: 0 }),
      wikiImportRaw: payload => importRawFromWorkDir(workDir, DEFAULT_WIKI_CONFIG, payload.srcRelPath, { userDataPath }),
    })
    expect(imported.type).toBe('run')
    if (imported.type !== 'run') return
    const sourceId = /sourceId=([0-9a-f-]{36})/.exec(imported.text)?.[1]
    expect(sourceId).toBeTruthy()
    const context = { userDataDir: userDataPath, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'assistant', lane: 'chat' }
    expect(await importWikiSourceForContext({ sourceRef: sourceId }, context)).toMatchObject({ success: true, data: { sourceId, sourceRevision: 1 } })
    const read = await readWikiSourceForContext({ sourceId, sourceRevision: 1 }, {
      ...context
    })
    expect(read).toMatchObject({ success: true, data: { sourceId, sourceRevision: 1, text: 'integration source' } })
  })

  it('bulk /wiki ingest imports only host-enumerated text files and emits their bound source ids', async () => {
    const workDir = temp('wiki-route-bulk-work-')
    const userDataPath = temp('wiki-route-bulk-data-')
    const wikiRoot = path.join(userDataPath, 'llm-wiki')
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    fs.mkdirSync(path.join(workDir, 'docs', 'nested'), { recursive: true })
    fs.mkdirSync(path.join(workDir, '.private'), { recursive: true })
    fs.mkdirSync(path.join(workDir, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(workDir, 'docs', 'nested', 'note.md'), 'nested source')
    fs.writeFileSync(path.join(workDir, '.private', 'secret.md'), 'excluded')
    fs.writeFileSync(path.join(workDir, 'node_modules', 'pkg', 'readme.md'), 'excluded')
    fs.writeFileSync(path.join(workDir, 'image.png'), Buffer.from([0, 1, 2]))
    const result = await parseWikiCommand('/wiki ingest --all', { manualActivated: [], manualDisabled: [] }, {
      wikiInit: vi.fn(),
      wikiStatus: vi.fn().mockResolvedValue({ rootPath: 'llm-wiki', initialized: true, pageCount: 0, rawCount: 0 }),
      wikiImportRaw: payload => importRawFromWorkDir(workDir, DEFAULT_WIKI_CONFIG, payload.srcRelPath, { userDataPath }),
      wikiImportAllRaw: () => importAllRawFromWorkDir(workDir, DEFAULT_WIKI_CONFIG, { userDataPath })
    })
    expect(result.type).toBe('run')
    if (result.type !== 'run') return
    const sourceId = /sourceId=([0-9a-f-]{36})/.exec(result.text)?.[1]
    expect(sourceId).toBeTruthy()
    expect(result.text).toContain('displayName=note.md')
    expect(result.text).not.toContain('secret')
    expect(result.text).not.toContain('readme')
    expect(fs.readdirSync(path.join(userDataPath, 'llm-wiki', '.wiki-service', 'sources'))).toHaveLength(1)
  })
})
