import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeSkillDirSize, parseFrontMatter, readSkillFromDirectory, validateSkillMeta } from './skillParser'

const tmpDirs: string[] = []

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('skillParser', () => {
  it('parses YAML block scalars without leaking nested metadata', () => {
    const { frontMatter } = parseFrontMatter(`---
name: demo-skill
description: >
  First line
  second line
metadata:
  name: should-not-win
triggers:
  - demo
---
body`)
    expect(frontMatter.description).toBe('First line second line\n')
    expect(frontMatter.name).toBe('demo-skill')
    expect(frontMatter.metadata).toEqual({ name: 'should-not-win' })
  })

  it('counts regular files but not symbolic links and stops at a limit', () => {
    const dir = mkTmpDir()
    fs.writeFileSync(path.join(dir, 'a.bin'), '12345')
    fs.symlinkSync(path.join(dir, 'a.bin'), path.join(dir, 'link.bin'))
    expect(computeSkillDirSize(dir, 5)).toEqual({ ok: true, totalBytes: 5, exceeded: false })
    expect(computeSkillDirSize(dir, 4).exceeded).toBe(true)
  })
  it('parses front matter and content', () => {
    const raw = `---
name: code-review
description: "代码审查规范"
triggers:
  - review
  - 审查
version: "2.0.0"
---

# Body
`
    const { frontMatter, content } = parseFrontMatter(raw)
    expect(frontMatter.name).toBe('code-review')
    expect(frontMatter.triggers).toEqual(['review', '审查'])
    expect(content.trim()).toBe('# Body')
  })

  it('validates required fields', () => {
    const result = validateSkillMeta({ name: 'bad name', description: 'x', triggers: ['a'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('名称格式')
  })

  it('allows missing triggers for external skills', () => {
    const result = validateSkillMeta({ name: 'demo-skill', description: 'demo' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meta.triggers).toEqual([])
  })

  it('reads skill from directory', () => {
    const dir = mkTmpDir()
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---
name: demo-skill
description: "演示 Skill"
triggers:
  - demo
---

Follow demo rules.
`
    )
    const skill = readSkillFromDirectory(dir, 'user')
    expect(skill.meta.name).toBe('demo-skill')
    expect(skill.content).toContain('Follow demo rules')
    expect(skill.scope).toBe('user')
  })
})
