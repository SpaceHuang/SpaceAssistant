import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CANDIDATES,
  buildGithubArchiveExtractMembers,
  discoverSkillDirs,
  githubArchiveRootFolder,
  installSkillsFromGithub,
  parseGithubSkillUrl,
  probeGithubSkillUrl,
  validateTarListing
} from './skillGithubInstall'
import { downloadGithubArchive } from './skillGithubArchive'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { isErrorCode } from '../../src/shared/errorCodes'

vi.mock('../agentLogger/agentLogger', () => ({ logAgentEvent: vi.fn() }))

vi.mock('./skillGithubArchive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skillGithubArchive')>()
  return { ...actual, downloadGithubArchive: vi.fn() }
})

const mockedDownload = vi.mocked(downloadGithubArchive)

beforeEach(() => {
  mockedDownload.mockReset()
  vi.mocked(logAgentEvent).mockClear()
})

/** 用本地目录树替代 codeload 归档下载，返回「解压后的仓库根目录」 */
function stubArchiveDownload(preparedRepoRoot: string): void {
  mockedDownload.mockImplementation(async (_owner, repo, branch, destDir) => {
    const target = path.join(destDir, 'extract', `${repo}-${branch}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(preparedRepoRoot, target, { recursive: true })
    return target
  })
}

function installNames(result: { installed: Array<{ meta: { name: string } }> }): string[] {
  return result.installed.map((skill) => skill.meta.name)
}

function writeBrokenSkill(dir: string, raw = 'this file has no front matter'): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), raw)
}

const tmpDirs: string[] = []

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-github-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function writeSkillMd(dir: string, name = path.basename(dir), description = `${name} demo`): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`)
}

function relOf(root: string): (dir: string) => string {
  return (dir) => path.relative(root, dir).split(path.sep).join('/')
}

function relDirs(root: string, dirs: string[]): string[] {
  return dirs.map(relOf(root))
}

describe('skillGithubInstall', () => {
  it('parses github repo urls', () => {
    expect(parseGithubSkillUrl('https://github.com/obra/superpowers')).toEqual({
      owner: 'obra',
      repo: 'superpowers',
      branch: 'main',
      subPath: ''
    })
  })

  it('normalizes query/hash, www host and git suffix', () => {
    expect(parseGithubSkillUrl(' https://www.github.com/acme/tools.git?tab=readme#x/')).toEqual({
      owner: 'acme', repo: 'tools', branch: 'main', subPath: ''
    })
  })

  it('rejects traversal subpaths', () => {
    expect(parseGithubSkillUrl('https://github.com/acme/tools/tree/main/../secret')).toBeNull()
  })

  it('rejects blob file urls so callers can request a directory', () => {
    expect(parseGithubSkillUrl('https://github.com/acme/tools/blob/main/SKILL.md')).toBeNull()
  })

  it('uses coded errors when a requested repository path is missing', () => {
    expect(() => discoverSkillDirs(mkTmpDir(), 'missing', false)).toThrow('SKILL_PATH_NOT_FOUND')
  })

  it('does not reject ordinary paths in verbose tar listings', () => {
    expect(() => validateTarListing([
      '-rwxr-xr-x user/group 0 2026-09-12 00:00 lib/',
      '-rw-r--r-- user/group 42 2026-09-12 00:00 help/SKILL.md'
    ].join('\n'))).not.toThrow()
  })

  it('rejects links in verbose tar listings', () => {
    expect(() => validateTarListing('lrwxrwxrwx user/group 0 2026-09-12 00:00 lib/out -> /tmp/out')).toThrow('SKILL_PATH_NOT_FOUND')
  })

  it('distinguishes unsupported hosts at the install boundary', async () => {
    await expect(import('./skillGithubInstall').then(({ installSkillsFromGithub }) => installSkillsFromGithub('/tmp', 'https://gitlab.com/a/b'))).rejects.toThrow('SKILL_URL_UNSUPPORTED_HOST')
  })

  it('parses github tree urls with sub path', () => {
    expect(parseGithubSkillUrl('https://github.com/MiniMax-AI/skills/tree/main/skills/pptx-generator')).toEqual({
      owner: 'MiniMax-AI',
      repo: 'skills',
      branch: 'main',
      subPath: 'skills/pptx-generator'
    })
  })

  it('resolves single skill directory', () => {
    const root = mkTmpDir()
    const skillDir = path.join(root, 'skills', 'demo-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# demo')

    expect(discoverSkillDirs(root, 'skills/demo-skill', false).dirs).toEqual([skillDir])
  })

  it('resolves all skill directories when installAll is true', () => {
    const root = mkTmpDir()
    const skillsRoot = path.join(root, 'skills')
    for (const name of ['alpha', 'beta']) {
      const dir = path.join(skillsRoot, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}`)
    }

    expect(discoverSkillDirs(root, 'skills', true).dirs.map((p) => path.basename(p))).toEqual(['alpha', 'beta'])
  })

  it('builds selective archive members for sub path installs', () => {
    expect(githubArchiveRootFolder('superpowers', 'main')).toBe('superpowers-main')
    expect(buildGithubArchiveExtractMembers('superpowers', 'main', 'skills')).toEqual(['superpowers-main/skills'])
    expect(buildGithubArchiveExtractMembers('skills', 'main', 'skills/pptx-generator')).toEqual([
      'skills-main/skills/pptx-generator'
    ])
    expect(buildGithubArchiveExtractMembers('guizang-social-card-skill', 'main')).toEqual(['guizang-social-card-skill-main'])
  })
})

describe('discoverSkillDirs', () => {
  it('discovers skills inside the skills container of a plugin marketplace repo', () => {
    const root = mkTmpDir()
    for (const dir of ['.codex-plugin', '.claude-plugin', 'commands', 'docs']) fs.mkdirSync(path.join(root, dir), { recursive: true })
    writeSkillMd(path.join(root, 'skills', 'alpha'))
    writeSkillMd(path.join(root, 'skills', 'beta'))

    const result = discoverSkillDirs(root, '', true)
    expect(relDirs(root, result.dirs)).toEqual(['skills/alpha', 'skills/beta'])
    expect(result.truncated).toBe(false)
    expect(result.visitedTruncated).toBe(false)
  })

  it('prefers the skills container and therefore excludes a root level template skill', () => {
    const root = mkTmpDir()
    writeSkillMd(path.join(root, 'template'))
    for (let i = 0; i < 19; i += 1) writeSkillMd(path.join(root, 'skills', `skill-${String(i).padStart(2, '0')}`))

    const result = discoverSkillDirs(root, '', true)
    expect(result.dirs).toHaveLength(19)
    expect(relDirs(root, result.dirs)).not.toContain('template')
  })

  it('ignores dot directories and their nested skills', () => {
    const root = mkTmpDir()
    writeSkillMd(path.join(root, 'skills', 'a'))
    writeSkillMd(path.join(root, '.claude', 'skills', 'b'))
    writeSkillMd(path.join(root, 'plugins', 'p', 'skills', 'c'))

    expect(relDirs(root, discoverSkillDirs(root, '', true).dirs)).toEqual(['skills/a'])
  })

  it('falls back to a bounded breadth first search when there is no skills container', () => {
    const root = mkTmpDir()
    writeSkillMd(path.join(root, 'group', 'one'))
    writeSkillMd(path.join(root, 'group', 'two'))

    expect(relDirs(root, discoverSkillDirs(root, '', true).dirs)).toEqual(['group/one', 'group/two'])
  })

  it('falls back when the skills container is empty', () => {
    const root = mkTmpDir()
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
    fs.writeFileSync(path.join(root, 'skills', 'README.md'), 'no skill here')
    writeSkillMd(path.join(root, 'other'))

    expect(relDirs(root, discoverSkillDirs(root, '', true).dirs)).toEqual(['other'])
  })

  it('does not descend into a directory that already contains SKILL.md', () => {
    const root = mkTmpDir()
    writeSkillMd(path.join(root, 'skills', 'a'))
    writeSkillMd(path.join(root, 'skills', 'a', 'assets', 'example'))

    expect(relDirs(root, discoverSkillDirs(root, '', true).dirs)).toEqual(['skills/a'])
  })

  it('caps discovery at three directory levels below the search root', () => {
    const root = mkTmpDir()
    writeSkillMd(path.join(root, 'lvl1', 'lvl2', 'lvl3'))
    writeSkillMd(path.join(root, 'deep', 'a', 'b', 'c'))

    expect(relDirs(root, discoverSkillDirs(root, '', true).dirs)).toEqual(['lvl1/lvl2/lvl3'])
  })

  it('keeps ignoring version control and dependency directories', () => {
    const root = mkTmpDir()
    writeSkillMd(path.join(root, 'node_modules', 'x'))
    writeSkillMd(path.join(root, '.github', 'y'))

    expect(() => discoverSkillDirs(root, '', true)).toThrow('SKILL_NOT_FOUND_IN_REPO')
  })

  it('resolves a repo root that itself is a skill directory', () => {
    const root = mkTmpDir()
    writeSkillMd(root)

    const result = discoverSkillDirs(root, '', true)
    expect(result.dirs).toEqual([root])
  })

  it('returns a stable order across repeated runs', () => {
    const root = mkTmpDir()
    for (const rel of ['skills/zeta', 'skills/alpha', 'skills/mid/one', 'skills/alpha/nested']) writeSkillMd(path.join(root, rel))

    const first = relDirs(root, discoverSkillDirs(root, '', true).dirs)
    const second = relDirs(root, discoverSkillDirs(root, '', true).dirs)
    expect(second).toEqual(first)
    expect(first).toEqual(['skills/alpha', 'skills/zeta', 'skills/mid/one'])
  })

  it('sorts mixed case, spaced and unicode directory names deterministically', () => {
    const root = mkTmpDir()
    for (const name of ['中文技能', 'zeta', 'Alpha', 'with space']) writeSkillMd(path.join(root, 'skills', name))

    const dirs = relDirs(root, discoverSkillDirs(root, '', true).dirs)
    expect(dirs).toHaveLength(4)
    expect(relDirs(root, discoverSkillDirs(root, '', true).dirs)).toEqual(dirs)
  })

  it('treats SKILL.md as case sensitive', () => {
    const root = mkTmpDir()
    fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true })
    fs.writeFileSync(path.join(root, 'skills', 'a', 'skill.md'), '---\nname: a\ndescription: d\n---\nbody\n')

    expect(() => discoverSkillDirs(root, '', true)).toThrow('SKILL_NOT_FOUND_IN_REPO')
  })

  it('falls back without crashing when skills exists as a file', () => {
    const root = mkTmpDir()
    fs.writeFileSync(path.join(root, 'skills'), 'not a directory')
    writeSkillMd(path.join(root, 'other'))

    expect(relDirs(root, discoverSkillDirs(root, '', true).dirs)).toEqual(['other'])
  })

  it('does not report truncation when the candidate count is exactly the cap', () => {
    const root = mkTmpDir()
    for (let i = 0; i < 100; i += 1) writeSkillMd(path.join(root, 'skills', `s-${String(i).padStart(3, '0')}`))

    const result = discoverSkillDirs(root, '', true)
    expect(result.dirs).toHaveLength(100)
    expect(result.truncated).toBe(false)
  })

  it('reports truncation and returns the cap when candidates exceed it', () => {
    const root = mkTmpDir()
    for (let i = 0; i < 101; i += 1) writeSkillMd(path.join(root, 'skills', `s-${String(i).padStart(3, '0')}`))

    const result = discoverSkillDirs(root, '', true)
    expect(result.dirs).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  it('flags visitedTruncated when the traversal budget is exhausted', () => {
    const root = mkTmpDir()
    writeSkillMd(path.join(root, 'aaa-skill'))
    for (let i = 0; i < 300; i += 1) {
      for (let j = 0; j < 7; j += 1) fs.mkdirSync(path.join(root, `grp-${i}`, `sub-${j}`), { recursive: true })
    }

    const result = discoverSkillDirs(root, '', true)
    expect(result.visitedTruncated).toBe(true)
    expect(relDirs(root, result.dirs)).toEqual(['aaa-skill'])
  })

  it('never walks outside the skills container when the container produced hits', () => {
    const root = mkTmpDir()
    writeSkillMd(path.join(root, 'skills', 'alpha'))
    writeSkillMd(path.join(root, 'outside', 'beta'))

    const spy = vi.spyOn(fs, 'readdirSync')
    try {
      const result = discoverSkillDirs(root, '', true)
      expect(relDirs(root, result.dirs)).toEqual(['skills/alpha'])
      const readPaths = spy.mock.calls.map((call) => path.resolve(String(call[0])))
      expect(readPaths.some((p) => p.startsWith(path.join(root, 'outside')))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('describes the actual search scope when nothing was found', () => {
    const root = mkTmpDir()
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true })

    expect(() => discoverSkillDirs(root, '', true)).toThrow(/已查找/)
  })

  it('walks very deep trees iteratively without overflowing the stack', () => {
    const root = mkTmpDir()
    let deep = root
    for (let i = 0; i < 30; i += 1) deep = path.join(deep, `lvl-${i}`)
    writeSkillMd(deep)

    expect(() => discoverSkillDirs(root, '', true)).toThrow('SKILL_NOT_FOUND_IN_REPO')
  })
})

describe('probeGithubSkillUrl', () => {
  it('keeps invalid candidates and reports their reasons instead of failing the probe', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    writeBrokenSkill(path.join(repo, 'skills', 'broken'))
    const oversize = path.join(repo, 'skills', 'oversize')
    fs.mkdirSync(oversize, { recursive: true })
    fs.writeFileSync(path.join(oversize, 'SKILL.md'), `---\nname: oversize\ndescription: big\n---\n${'x'.repeat(100 * 1024)}`)
    stubArchiveDownload(repo)

    const result = await probeGithubSkillUrl('https://github.com/acme/tools', mkTmpDir())

    expect(result.candidates.map((c) => [c.subPath, c.status])).toEqual([
      ['skills/alpha', 'ok'],
      ['skills/broken', 'invalid'],
      ['skills/oversize', 'invalid']
    ])
    expect(result.candidates[1]!.reason).toContain('SKILL_FRONT_MATTER')
    expect(result.candidates[2]!.reason).toContain('SKILL_MD_TOO_LARGE')
    expect(result.truncated).toBe(false)
    expect(result.visitedTruncated).toBe(false)
  })

  it('returns an all-invalid candidate list without throwing', async () => {
    const repo = mkTmpDir()
    writeBrokenSkill(path.join(repo, 'skills', 'one'))
    writeBrokenSkill(path.join(repo, 'skills', 'two'))
    stubArchiveDownload(repo)

    const result = await probeGithubSkillUrl('https://github.com/acme/tools')
    expect(result.candidates.map((c) => c.status)).toEqual(['invalid', 'invalid'])
    expect(result.candidates.every((c) => Boolean(c.reason))).toBe(true)
  })

  it('marks candidates whose name already exists in the user skills directory', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    writeSkillMd(path.join(repo, 'skills', 'beta'))
    const userData = mkTmpDir()
    writeSkillMd(path.join(userData, 'skills', 'alpha'))
    stubArchiveDownload(repo)

    const result = await probeGithubSkillUrl('https://github.com/acme/tools', userData)

    const alpha = result.candidates.find((c) => c.name === 'alpha')!
    const beta = result.candidates.find((c) => c.name === 'beta')!
    expect(alpha.status).toBe('name-conflict')
    expect(alpha.reason).toContain('SKILL_NAME_CONFLICT')
    expect(beta.status).toBe('ok')
  })

  it('passes the truncation flags through to the caller', async () => {
    const repo = mkTmpDir()
    for (let i = 0; i < MAX_CANDIDATES + 1; i += 1) writeSkillMd(path.join(repo, 'skills', `s-${String(i).padStart(3, '0')}`))
    stubArchiveDownload(repo)

    const result = await probeGithubSkillUrl('https://github.com/acme/tools')
    expect(result.candidates).toHaveLength(MAX_CANDIDATES)
    expect(result.truncated).toBe(true)
    expect(result.visitedTruncated).toBe(false)
  })

  it('describes the searched scope when the repository has no skill', async () => {
    const repo = mkTmpDir()
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    stubArchiveDownload(repo)

    await expect(probeGithubSkillUrl('https://github.com/acme/tools')).rejects.toThrow(/已查找/)
  })
})

describe('installSkillsFromGithub', () => {
  it('installs the valid candidates and skips invalid ones in the whole repo mode', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    writeBrokenSkill(path.join(repo, 'skills', 'broken'))
    stubArchiveDownload(repo)
    const userData = mkTmpDir()

    const result = await installSkillsFromGithub(userData, 'https://github.com/acme/tools', { installAll: true })

    expect(installNames(result)).toEqual(['alpha'])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.subPath).toBe('skills/broken')
    expect(result.overwritten).toEqual([])
    expect(fs.existsSync(path.join(userData, 'skills', 'broken'))).toBe(false)
    expect(mockedDownload).toHaveBeenCalledTimes(1)
  })

  it('installs a batch of sub paths with a single archive download', async () => {
    const repo = mkTmpDir()
    for (const name of ['alpha', 'beta', 'gamma']) writeSkillMd(path.join(repo, 'skills', name))
    writeBrokenSkill(path.join(repo, 'skills', 'broken'))
    stubArchiveDownload(repo)
    const userData = mkTmpDir()
    writeSkillMd(path.join(userData, 'skills', 'beta'))

    const result = await installSkillsFromGithub(userData, 'https://github.com/acme/tools', {
      subPaths: ['skills/alpha', 'skills/beta', 'skills/gamma', 'skills/broken']
    })

    expect(mockedDownload).toHaveBeenCalledTimes(1)
    expect(mockedDownload.mock.calls[0]![4]).toBeUndefined()
    expect(installNames(result)).toEqual(['alpha', 'gamma'])
    expect(result.skipped.map((s) => s.subPath)).toEqual(['skills/beta', 'skills/broken'])
    expect(result.skipped[0]!.reason).toContain('SKILL_NAME_CONFLICT')
    expect(result.skipped[1]!.reason).toContain('SKILL_FRONT_MATTER')
    expect(result.overwritten).toEqual([])
  })

  it('overwrites conflicting skills when overwrite is true and reports them', async () => {
    const repo = mkTmpDir()
    for (const name of ['alpha', 'beta']) writeSkillMd(path.join(repo, 'skills', name))
    stubArchiveDownload(repo)
    const userData = mkTmpDir()
    writeSkillMd(path.join(userData, 'skills', 'beta'))

    const result = await installSkillsFromGithub(userData, 'https://github.com/acme/tools', {
      subPaths: ['skills/alpha', 'skills/beta'],
      overwrite: true
    })

    expect(installNames(result)).toEqual(['alpha', 'beta'])
    expect(result.overwritten).toEqual(['beta'])
    expect(result.skipped).toEqual([])
  })

  it('skips sub paths that are missing from the extracted tree without aborting the batch', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    stubArchiveDownload(repo)
    const userData = mkTmpDir()

    const result = await installSkillsFromGithub(userData, 'https://github.com/acme/tools', {
      subPaths: ['skills/alpha', 'skills/nope', 'skills/alpha']
    })

    expect(installNames(result)).toEqual(['alpha'])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.subPath).toBe('skills/nope')
    expect(result.skipped[0]!.reason).toContain('SKILL_PATH_NOT_FOUND')
  })

  it('returns an empty result instead of throwing when every candidate conflicts', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    stubArchiveDownload(repo)
    const userData = mkTmpDir()
    writeSkillMd(path.join(userData, 'skills', 'alpha'))

    const result = await installSkillsFromGithub(userData, 'https://github.com/acme/tools', { subPaths: ['skills/alpha'] })

    expect(installNames(result)).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.reason).toContain('SKILL_NAME_CONFLICT')
  })

  it('throws SKILL_NO_INSTALLABLE_CANDIDATE when every candidate is invalid', async () => {
    const repo = mkTmpDir()
    writeBrokenSkill(path.join(repo, 'skills', 'broken'))
    stubArchiveDownload(repo)

    await expect(
      installSkillsFromGithub(mkTmpDir(), 'https://github.com/acme/tools', { subPaths: ['skills/broken'] })
    ).rejects.toThrow('SKILL_NO_INSTALLABLE_CANDIDATE')
  })

  it('rejects an unsafe sub path payload as a whole', async () => {
    const userData = mkTmpDir()
    const url = 'https://github.com/acme/tools'
    for (const bad of ['../escape', '/absolute', 'C:/absolute', 'C:\\absolute', '', '   ', 'skills/../escape']) {
      await expect(installSkillsFromGithub(userData, url, { subPaths: [bad] })).rejects.toThrow('SKILL_URL_INVALID')
    }
    const tooMany = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => `skills/s-${i}`)
    await expect(installSkillsFromGithub(userData, url, { subPaths: tooMany })).rejects.toThrow('SKILL_URL_INVALID')
    expect(mockedDownload).not.toHaveBeenCalled()
  })

  it('deduplicates sub paths and lets subPaths win over subPath', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    writeSkillMd(path.join(repo, 'skills', 'beta'))
    stubArchiveDownload(repo)
    const userData = mkTmpDir()

    const result = await installSkillsFromGithub(userData, 'https://github.com/acme/tools', {
      subPath: 'skills/beta',
      subPaths: ['skills/alpha', 'skills/alpha']
    })

    expect(installNames(result)).toEqual(['alpha'])
    expect(fs.existsSync(path.join(userData, 'skills', 'beta'))).toBe(false)
    expect(mockedDownload).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logAgentEvent)).toHaveBeenCalledWith('warn', 'skills.install.sub_paths_override', expect.objectContaining({ subPath: 'skills/beta' }))
  })

  it('treats an empty subPaths array as the installAll mode', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    stubArchiveDownload(repo)

    const result = await installSkillsFromGithub(mkTmpDir(), 'https://github.com/acme/tools', { subPaths: [], installAll: true })

    expect(installNames(result)).toEqual(['alpha'])
  })

  it('keeps whole-error semantics for an explicit single sub path', async () => {
    const repo = mkTmpDir()
    writeBrokenSkill(path.join(repo, 'skills', 'broken'))
    stubArchiveDownload(repo)

    await expect(
      installSkillsFromGithub(mkTmpDir(), 'https://github.com/acme/tools', { subPath: 'skills/broken', installAll: false })
    ).rejects.toThrow('SKILL_FRONT_MATTER')
  })

  it('records each skill own relative path in the source metadata', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    writeSkillMd(path.join(repo, 'skills', 'beta'))
    stubArchiveDownload(repo)
    const userData = mkTmpDir()

    const result = await installSkillsFromGithub(userData, 'https://github.com/acme/tools', { installAll: true })

    expect(installNames(result)).toEqual(['alpha', 'beta'])
    for (const name of ['alpha', 'beta']) {
      const meta = JSON.parse(fs.readFileSync(path.join(userData, 'skills', name, '.skill-source.json'), 'utf8'))
      expect(meta.subPath).toBe(`skills/${name}`)
      expect(meta.sourceUrl).toBe(`https://github.com/acme/tools/tree/main/skills/${name}`)
    }
  })

  it('only reports skills that were actually overwritten', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    stubArchiveDownload(repo)

    const result = await installSkillsFromGithub(mkTmpDir(), 'https://github.com/acme/tools', { installAll: true, overwrite: true })

    expect(installNames(result)).toEqual(['alpha'])
    expect(result.overwritten).toEqual([])
  })

  it('reports coded reasons for every skipped candidate', async () => {
    const repo = mkTmpDir()
    writeSkillMd(path.join(repo, 'skills', 'alpha'))
    writeBrokenSkill(path.join(repo, 'skills', 'broken'))
    stubArchiveDownload(repo)
    const userData = mkTmpDir()
    writeSkillMd(path.join(userData, 'skills', 'alpha'))

    const result = await installSkillsFromGithub(userData, 'https://github.com/acme/tools', { installAll: true })

    expect(result.skipped.length).toBeGreaterThan(0)
    for (const item of result.skipped) {
      expect(isErrorCode(item.reason.split(':')[0]!.trim())).toBe(true)
    }
  })
})
