import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('rejects a workDir-external symlink swapped in after realpath validation', async () => {
    const root = await makeRoot()
    const outside = await makeRoot()
    const filePath = path.join(root, 'AGENTS.md')
    const privateFile = path.join(outside, 'private.txt')
    await fs.writeFile(filePath, 'project rules')
    await fs.writeFile(privateFile, 'PRIVATE_OUTSIDE_WORKDIR')
    const realpath = fs.realpath.bind(fs)
    let swapped = false
    const spy = vi.spyOn(fs, 'realpath').mockImplementation(async (input: Parameters<typeof fs.realpath>[0], options?: Parameters<typeof fs.realpath>[1]) => {
      const resolved = await realpath(input as string, options as never)
      if (input === filePath && !swapped) {
        swapped = true
        await fs.unlink(filePath)
        await fs.symlink(privateFile, filePath)
      }
      return resolved
    })
    try {
      const result = await loadAgentsMd(root)
      expect(result.status).toBe('outside-workdir')
      expect(result.content).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('does not read an external target swapped in after the file handle is opened', async () => {
    const root = await makeRoot()
    const outside = await makeRoot()
    const filePath = path.join(root, 'AGENTS.md')
    const privateFile = path.join(outside, 'private.txt')
    await fs.writeFile(filePath, 'project rules')
    await fs.writeFile(privateFile, 'PRIVATE_OUTSIDE_WORKDIR')

    const result = await loadAgentsMd(root, {
      afterOpen: async () => {
        await fs.unlink(filePath)
        await fs.symlink(privateFile, filePath)
      }
    })
    expect(result.status).toBe('outside-workdir')
    expect(result.content).toBeNull()
  })

  it('rejects a workDir symlink retargeted outside before open', async () => {
    const root = await makeRoot()
    const outside = await makeRoot()
    const aliasContainer = await makeRoot()
    const workDirAlias = path.join(aliasContainer, 'workspace')
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'project rules')
    await fs.writeFile(path.join(outside, 'AGENTS.md'), 'PRIVATE_OUTSIDE_WORKDIR')
    await fs.symlink(root, workDirAlias)

    const result = await loadAgentsMd(workDirAlias, {
      beforeRead: async () => {
        await fs.unlink(workDirAlias)
        await fs.symlink(outside, workDirAlias)
      }
    })
    expect(result.status).toBe('unstable')
    expect(result.content).toBeNull()
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

  it('retries an atomic editor replacement after opening and reads only the complete new version', async () => {
    const root = await makeRoot()
    const current = path.join(root, 'AGENTS.md')
    const replacement = path.join(root, '.AGENTS.md.tmp')
    await fs.writeFile(current, 'old')
    await fs.writeFile(replacement, 'complete new rule')
    let replaced = false
    await expect(loadAgentsMd(root, { afterOpen: async () => {
      if (replaced) return
      replaced = true
      await fs.rename(replacement, current)
    } })).resolves.toMatchObject({ status: 'loaded', content: 'complete new rule' })
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

  it('reserves prompt wrapper tokens from the configured instruction budget', async () => {
    const root = await makeRoot()
    const content = 'rule '.repeat(20)
    await fs.writeFile(path.join(root, 'AGENTS.md'), content)
    await expect(loadAgentsMd(root, { contextWindow: 1_000, promptOverheadTokens: 40 }))
      .resolves.toMatchObject({ status: 'token-budget-exceeded', content: null })
  })
})
