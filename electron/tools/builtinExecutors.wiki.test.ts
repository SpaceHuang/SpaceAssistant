import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { writeFileExecutor, editFileExecutor } from './builtinExecutors'
import type { ToolExecutionContext } from './types'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'

const tmpDirs: string[] = []

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true })
  }
})

function makeCtx(workDir: string, cache: FileStateCache): ToolExecutionContext {
  return {
    workDir,
    userDataDir: workDir,
    requestId: 'r1',
    toolUseId: 't1',
    sessionId: 's1',
    sendProgress: () => {},
    signal: new AbortController().signal,
    fileStateCache: cache,
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false },
    wikiConfig: { ...DEFAULT_WIKI_CONFIG, enabled: true }
  }
}

describe('wiki raw readonly guard', () => {
  it('blocks write_file and edit_file under raw/', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-wiki-raw-'))
    tmpDirs.push(tmpDir)
    await fs.mkdir(path.join(tmpDir, 'llm-wiki', 'raw'), { recursive: true })
    const rel = 'llm-wiki/raw/note.md'
    const cache = new FileStateCache()
    const ctx = makeCtx(tmpDir, cache)

    const write = await writeFileExecutor.execute({ path: rel, content: 'hack' }, ctx)
    expect(write.success).toBe(false)
    expect(write.error).toContain('WIKI_RAW_READONLY')

    const edit = await editFileExecutor.execute({ path: rel, old_string: 'a', new_string: 'b' }, ctx)
    expect(edit.success).toBe(false)
    expect(edit.error).toContain('WIKI_RAW_READONLY')
  })
})
