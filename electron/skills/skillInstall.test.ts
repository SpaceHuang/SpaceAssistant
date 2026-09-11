import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { installSkillToUserDir } from './skillInstall'

const dirs: string[] = []
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-install-test-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function source(root: string, name = 'demo-skill') {
  const dir = path.join(root, 'source'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: demo\n---\nbody\n`)
  return dir
}

describe('installSkillToUserDir source metadata', () => {
  it('writes GitHub source metadata atomically', async () => {
    const root = temp(); const result = await installSkillToUserDir(root, source(root), false, {
      schemaVersion: 1, sourceType: 'github', sourceUrl: 'https://github.com/a/b', owner: 'a', repo: 'b', ref: 'main', subPath: '', installedAt: 'now', appVersion: '0.1.7'
    })
    expect(JSON.parse(fs.readFileSync(path.join(result.directoryPath, '.skill-source.json'), 'utf8')).repo).toBe('b')
    expect(fs.readdirSync(path.join(root, 'skills')).some((n) => n.startsWith('.tmp-'))).toBe(false)
  })

  it('does not write metadata for local installs', async () => {
    const root = temp(); const result = await installSkillToUserDir(root, source(root))
    expect(fs.existsSync(path.join(result.directoryPath, '.skill-source.json'))).toBe(false)
  })
})
