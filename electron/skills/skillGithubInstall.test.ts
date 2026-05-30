import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGithubSkillUrl, resolveSkillSourceDirs } from './skillGithubInstall'

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
})
