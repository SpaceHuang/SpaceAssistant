import { describe, expect, it } from 'vitest'
import { ArtifactChangeCursor } from './changeCursor'

describe('ArtifactChangeCursor', () => {
  it('summarizes only successful artifact writes for its request', () => {
    const cursor = new ArtifactChangeCursor('request-1')
    cursor.record({ requestId: 'request-1', artifactId: 'a1', container: 'project', role: 'primary', finalPath: 'src/a.ts', success: true })
    cursor.record({ requestId: 'request-1', artifactId: 'a2', container: 'scratch', role: 'scratch', finalPath: 'run.sh', success: false })
    cursor.record({ requestId: 'other', artifactId: 'a3', container: 'package', role: 'primary', finalPath: 'report.md', success: true })
    expect(cursor.entries()).toEqual([{ artifactId: 'a1', container: 'project', role: 'primary', finalPath: 'src/a.ts' }])
  })
})
