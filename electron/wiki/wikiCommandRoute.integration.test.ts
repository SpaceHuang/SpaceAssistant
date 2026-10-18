import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWikiCommand } from '../../src/shared/outbound/wikiCommandService'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { importRawFromWorkDir } from './wikiImport'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiSourceService } from './wikiSourceService'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function temp(prefix: string) { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(root); return fs.realpathSync(root) }

describe('Wiki command to sourceId integration', () => {
  it('routes /wiki ingest through the real shared import and reads its bound snapshot', async () => {
    const workDir = temp('wiki-route-work-')
    const userDataPath = temp('wiki-route-data-')
    fs.writeFileSync(path.join(workDir, 'note.md'), 'integration source')
    const imported = await parseWikiCommand('/wiki ingest note.md', { manualActivated: [], manualDisabled: [] }, {
      wikiInit: vi.fn(),
      wikiStatus: vi.fn().mockResolvedValue({ rootPath: 'llm-wiki', initialized: true, pageCount: 0, rawCount: 0 }),
      wikiImportRaw: payload => importRawFromWorkDir(workDir, DEFAULT_WIKI_CONFIG, payload.srcRelPath, { userDataPath }),
    })
    expect(imported.type).toBe('run')
    if (imported.type !== 'run') return
    const sourceId = /sourceId=([0-9a-f-]{36})/.exec(imported.text)?.[1]
    expect(sourceId).toBeTruthy()
    const store = createWikiFileStore(path.join(userDataPath, 'llm-wiki'))
    const sourceService = createWikiSourceService({ store, resolveSourceRef: () => undefined, validateSource: async () => false, authorize: async () => true })
    await expect(sourceService.readSource(sourceId!, { callerId: 'assistant', lane: 'chat' })).resolves.toMatchObject({ sourceId, text: 'integration source' })
  })
})
