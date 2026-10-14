import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadAgentsMd } from './projectInstructions'

const roots: string[] = []
async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-agents-md-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('loadAgentsMd', () => {
  it('loads only the workDir root file and decodes BOM, CRLF, and Chinese', async () => {
    const root = await makeRoot()
    await fs.writeFile(path.join(root, 'AGENTS.md'), '\uFEFF第一行\r\n中文约定\r\n')
    await fs.mkdir(path.join(root, 'nested'))
    await fs.writeFile(path.join(root, 'nested', 'AGENTS.md'), 'must not load')

    await expect(loadAgentsMd(root)).resolves.toMatchObject({ status: 'loaded', content: '第一行\n中文约定\n' })
  })

  it('reports missing and whitespace files without an instruction body', async () => {
    const root = await makeRoot()
    await expect(loadAgentsMd(root)).resolves.toMatchObject({ status: 'missing', content: null })
    await fs.writeFile(path.join(root, 'AGENTS.md'), ' \r\n\t ')
    await expect(loadAgentsMd(root)).resolves.toMatchObject({ status: 'empty', content: null })
  })

  it('reports disabled, invalid-workdir, and permission failures as structured states', async () => {
    const root = await makeRoot()
    await expect(loadAgentsMd(root, { enabled: false })).resolves.toMatchObject({ status: 'disabled', content: null })
    await expect(loadAgentsMd('')).resolves.toMatchObject({ status: 'invalid-workdir', content: null })
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'restricted')
    await expect(loadAgentsMd(root, { beforeRead: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }))
      .resolves.toMatchObject({ status: 'read-error', content: null })
  })

  it('rejects oversize, invalid UTF-8, directories, and links outside workDir', async () => {
    const root = await makeRoot()
    const outside = await makeRoot()
    await fs.writeFile(path.join(root, 'AGENTS.md'), Buffer.alloc(32 * 1024 + 1, 0x61))
    await expect(loadAgentsMd(root)).resolves.toMatchObject({ status: 'too-large', content: null })
    await fs.writeFile(path.join(root, 'AGENTS.md'), Buffer.from([0xc3, 0x28]))
    await expect(loadAgentsMd(root)).resolves.toMatchObject({ status: 'invalid-encoding', content: null })
    await fs.rm(path.join(root, 'AGENTS.md'))
    await fs.mkdir(path.join(root, 'AGENTS.md'))
    await expect(loadAgentsMd(root)).resolves.toMatchObject({ status: 'not-file', content: null })
    await fs.rmdir(path.join(root, 'AGENTS.md'))
    await fs.symlink(path.join(outside, 'rule.md'), path.join(root, 'AGENTS.md'))
    await fs.writeFile(path.join(outside, 'rule.md'), 'outside')
    await expect(loadAgentsMd(root)).resolves.toMatchObject({ status: 'outside-workdir', content: null })
  })

  it('allows an in-workdir symlink and keeps simultaneous directories isolated', async () => {
    const a = await makeRoot()
    const b = await makeRoot()
    await fs.writeFile(path.join(a, 'policy.md'), 'A rule')
    await fs.symlink('policy.md', path.join(a, 'AGENTS.md'))
    await fs.writeFile(path.join(b, 'AGENTS.md'), 'B rule')
    const [resultA, resultB] = await Promise.all([loadAgentsMd(a), loadAgentsMd(b)])
    expect(resultA).toMatchObject({ status: 'loaded', content: 'A rule' })
    expect(resultB).toMatchObject({ status: 'loaded', content: 'B rule' })
  })

  it('reads a stable version across atomic editor replacement', async () => {
    const root = await makeRoot()
    const current = path.join(root, 'AGENTS.md')
    const replacement = path.join(root, '.AGENTS.md.tmp')
    await fs.writeFile(current, 'old')
    await fs.writeFile(replacement, 'complete new rule')
    await fs.rename(replacement, current)
    await expect(loadAgentsMd(root)).resolves.toMatchObject({ status: 'loaded', content: 'complete new rule' })
  })

  it('retries a normal concurrent modification once and then reports an unstable read without old content', async () => {
    const root = await makeRoot()
    const filePath = path.join(root, 'AGENTS.md')
    await fs.writeFile(filePath, 'old version')
    let changed = false
    const updated = await loadAgentsMd(root, {
      beforeRead: async (attempt) => {
        if (attempt === 0 && !changed) {
          changed = true
          await fs.writeFile(filePath, 'complete updated version')
        }
      }
    })
    expect(updated).toMatchObject({ status: 'loaded', content: 'complete updated version' })

    let calls = 0
    const unstable = await loadAgentsMd(root, {
      beforeRead: async () => {
        calls += 1
        await fs.writeFile(filePath, `version ${calls} with a different size`)
      }
    })
    expect(calls).toBe(2)
    expect(unstable).toMatchObject({ status: 'unstable', content: null })
  })

  it('returns per-request metadata and obeys a context-window token budget', async () => {
    const root = await makeRoot()
    await fs.writeFile(path.join(root, 'AGENTS.md'), '规则'.repeat(40))
    const result = await loadAgentsMd(root, { contextWindow: 100 })
    expect(result).toMatchObject({ status: 'token-budget-exceeded', content: null, byteLength: Buffer.byteLength('规则'.repeat(40), 'utf8') })
    expect(result).toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/), loadedAt: expect.any(Number), sourcePath: 'AGENTS.md' })
  })
})
