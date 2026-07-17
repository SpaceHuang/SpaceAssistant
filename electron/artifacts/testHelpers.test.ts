import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createArtifactTestFixture } from './testHelpers'

describe('createArtifactTestFixture', () => {
  it('removes its workDir and SQLite database during teardown', () => {
    const fixture = createArtifactTestFixture()
    const { dbPath, workDir } = fixture

    expect(fs.existsSync(workDir)).toBe(true)
    expect(fs.existsSync(dbPath)).toBe(true)

    fixture.teardown()

    expect(fs.existsSync(workDir)).toBe(false)
    expect(fs.existsSync(dbPath)).toBe(false)
  })
})
