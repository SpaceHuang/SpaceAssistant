import { describe, expect, it } from 'vitest'
import { buildArtifactCompletionSummary } from './completionSummary'

describe('buildArtifactCompletionSummary', () => {
  it('groups only the current request changes by container', () => {
    expect(buildArtifactCompletionSummary([
      { artifactId: 'p', container: 'project', role: 'primary', finalPath: 'src/a.ts' },
      { artifactId: 'k', container: 'package', role: 'primary', finalPath: 'report.md' },
      { artifactId: 's', container: 'scratch', role: 'scratch', finalPath: 'run.sh' }
    ])).toEqual({
      project: [{ finalPath: 'src/a.ts' }],
      package: [{ finalPath: 'report.md' }],
      scratch: [{ finalPath: 'run.sh' }]
    })
  })

  it('includes stage in completion summary items', () => {
    expect(buildArtifactCompletionSummary([
      { artifactId: 'p', container: 'project', role: 'primary', finalPath: 'report.md', stage: 'final' }
    ])).toEqual({ project: [{ finalPath: 'report.md', stage: 'final' }], package: [], scratch: [] })
  })
})
