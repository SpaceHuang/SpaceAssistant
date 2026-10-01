import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(__dirname, '../..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
  build?: { extraResources?: Array<{ from?: string; to?: string }> }
}
const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, { version?: string; license?: string }>
}

describe('third party license packaging', () => {
  it('preserves the pinned pi-ai MIT notice in the packaged application resources', () => {
    const piAi = packageLock.packages?.['node_modules/@earendil-works/pi-ai']
    const noticePath = path.join(projectRoot, 'resources/licenses/pi-ai/LICENSE')
    const notice = fs.existsSync(noticePath) ? fs.readFileSync(noticePath, 'utf8') : ''
    const packagedNotices = packageJson.build?.extraResources?.some((resource) =>
      resource.from === 'resources/licenses' && resource.to === 'licenses'
    )

    expect(piAi).toMatchObject({ version: '0.87.1', license: 'MIT' })
    expect(notice).toContain('Copyright (c) 2025 Mario Zechner')
    expect(notice).toContain('The above copyright notice and this permission notice shall be included in all')
    expect(packagedNotices).toBe(true)
  })
})
