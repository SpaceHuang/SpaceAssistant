import { describe, expect, it } from 'vitest'
import type { SpaceAssistantApi } from '../src/shared/api'

type ArtifactPayloadKeys =
  | keyof Parameters<SpaceAssistantApi['artifactList']>[0]
  | keyof Parameters<SpaceAssistantApi['artifactDelete']>[0]
  | keyof Parameters<SpaceAssistantApi['artifactCleanSession']>[0]
  | keyof Parameters<SpaceAssistantApi['artifactDecisionResponse']>[0]
  | keyof Parameters<SpaceAssistantApi['artifactRelocate']>[0]
  | keyof Parameters<SpaceAssistantApi['artifactSetDefaultDir']>[0]

describe('artifact preload API contract', () => {
  it('does not allow renderer payloads to include workspace root fields', () => {
    const forbidden: ArtifactPayloadKeys[] = ['workDir', 'workspaceRoot', 'workspaceRootReal'] as never
    expect(forbidden).toEqual(['workDir', 'workspaceRoot', 'workspaceRootReal'])
  })

  it('limits artifact:list to sessionId only', () => {
    const payload: Parameters<SpaceAssistantApi['artifactList']>[0] = { sessionId: 'session-1' }
    expect(payload).toEqual({ sessionId: 'session-1' })
  })
})
