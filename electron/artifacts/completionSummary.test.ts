import { describe, expect, it } from 'vitest'
import { buildArtifactCompletionSummary } from './completionSummary'

describe('buildArtifactCompletionSummary', () => {
  it('groups only the current request changes by container', () => {
    expect(buildArtifactCompletionSummary([
      { artifactId: 'p', container: 'project', role: 'primary', finalPath: 'src/a.ts' },
      { artifactId: 'k', container: 'package', role: 'primary', finalPath: 'report.md' },
      { artifactId: 's', container: 'scratch', role: 'scratch', finalPath: 'run.sh' }
    ])).toEqual({ project: ['src/a.ts'], package: ['report.md'], scratch: ['run.sh'] })
  })
})
