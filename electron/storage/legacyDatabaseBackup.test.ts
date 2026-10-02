import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveLegacyDatabaseJsonBackup } from './legacyDatabaseBackup'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('legacy database JSON backup cleanup', () => {
  it('does nothing when the file is missing or the user declines', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-json-backup-'))
    roots.push(root)
    expect(archiveLegacyDatabaseJsonBackup(root, true)).toEqual({ status: 'missing' })
    const source = path.join(root, 'bak-spaceassistant-data.json')
    fs.writeFileSync(source, 'legacy data')
    expect(archiveLegacyDatabaseJsonBackup(root, false)).toEqual({ status: 'declined' })
    expect(fs.readFileSync(source, 'utf8')).toBe('legacy data')
  })

  it('moves the confirmed backup into the archive and verifies its size', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-json-backup-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'bak-spaceassistant-data.json'), 'legacy database export')
    const result = archiveLegacyDatabaseJsonBackup(root, true)
    expect(result).toMatchObject({ status: 'archived', bytes: Buffer.byteLength('legacy database export') })
    expect(fs.existsSync(path.join(root, 'bak-spaceassistant-data.json'))).toBe(false)
    expect(fs.readFileSync(result.archivePath!, 'utf8')).toBe('legacy database export')
  })
})
