import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGithubSkillUrl, resolveSkillSourceDirs, buildGithubArchiveExtractMembers, githubArchiveRootFolder, validateTarListing } from './skillGithubInstall'

const tmpDirs: string[] = []

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-github-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

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
    expect(() => resolveSkillSourceDirs(mkTmpDir(), 'missing', false)).toThrow('SKILL_PATH_NOT_FOUND')
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

    expect(resolveSkillSourceDirs(root, 'skills/demo-skill', false)).toEqual([skillDir])
  })

  it('resolves all skill directories when installAll is true', () => {
    const root = mkTmpDir()
    const skillsRoot = path.join(root, 'skills')
    for (const name of ['alpha', 'beta']) {
      const dir = path.join(skillsRoot, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}`)
    }

    expect(resolveSkillSourceDirs(root, 'skills', true).map((p) => path.basename(p))).toEqual(['alpha', 'beta'])
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
