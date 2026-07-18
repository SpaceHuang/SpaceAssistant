import { describe, expect, it } from 'vitest'
import { groupSessionArtifacts } from './SessionArtifactsPanel'
import type { ArtifactApiItem } from '../../../shared/api'

const t = (key: string) => key

describe('SessionArtifactsPanel', () => {
  it('groups artifacts into project, package, scratch and reference sections', () => {
    const artifacts: ArtifactApiItem[] = [
      { id: 'p1', sessionId: 's1', container: 'project', role: 'primary', title: 'Auth', finalPath: 'src/a.ts', status: 'active' },
      { id: 'k1', sessionId: 's1', container: 'package', role: 'primary', title: 'Report', finalPath: 'report.md', status: 'active', packageId: 'pkg-1' },
      { id: 'r1', sessionId: 's1', container: 'package', role: 'reference', title: 'Source', finalPath: 'report.materials/source.md', status: 'active', packageId: 'pkg-1' },
      { id: 's1', sessionId: 's1', container: 'scratch', role: 'scratch', title: 'Run', finalPath: '.spaceassistant/runs/s1/script/run.sh', status: 'active' }
    ]
    const groups = groupSessionArtifacts(artifacts, t)
    expect(groups.map((group) => group.key)).toEqual(['project', 'package-pkg-1', 'scratch'])
  })

  it('defaults project and package expanded while scratch collapsed', () => {
    const artifacts: ArtifactApiItem[] = [
      { id: 'p1', sessionId: 's1', container: 'project', role: 'primary', title: 'Auth', finalPath: 'src/a.ts', status: 'active' },
      { id: 's1', sessionId: 's1', container: 'scratch', role: 'scratch', title: 'Run', finalPath: 'run.sh', status: 'active' }
    ]
    const groups = groupSessionArtifacts(artifacts, t)
    expect(groups.find((group) => group.key === 'project')?.defaultExpanded).toBe(true)
    expect(groups.find((group) => group.key === 'scratch')?.defaultExpanded).toBe(false)
  })

  it('keeps stage on grouped artifacts for panel rendering', () => {
    const artifacts: ArtifactApiItem[] = [
      {
        id: 'p1',
        sessionId: 's1',
        container: 'project',
        role: 'primary',
        title: 'Draft',
        finalPath: 'report.md',
        status: 'active',
        stage: 'draft'
      }
    ]
    expect(groupSessionArtifacts(artifacts, t)[0]?.items[0]?.stage).toBe('draft')
  })
})
