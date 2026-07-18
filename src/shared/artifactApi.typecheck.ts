type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Expect<Value extends true> = Value

import type { SpaceAssistantApi } from './api'

type ForbiddenArtifactPayloadKey = 'workDir' | 'workspaceRoot' | 'workspaceRootReal'

type PayloadHasForbiddenKey<T> = Extract<keyof T, ForbiddenArtifactPayloadKey> extends never ? true : false

type ArtifactListPayload = Parameters<SpaceAssistantApi['artifactList']>[0]
type ArtifactDeletePayload = Parameters<SpaceAssistantApi['artifactDelete']>[0]
type ArtifactCleanPayload = Parameters<SpaceAssistantApi['artifactCleanSession']>[0]
type ArtifactDecisionPayload = Parameters<SpaceAssistantApi['artifactDecisionResponse']>[0]
type ArtifactRelocatePayload = Parameters<SpaceAssistantApi['artifactRelocate']>[0]
type ArtifactDefaultDirPayload = Parameters<SpaceAssistantApi['artifactSetDefaultDir']>[0]

type ArtifactApiGuard = Expect<
  PayloadHasForbiddenKey<ArtifactListPayload> extends true
    ? PayloadHasForbiddenKey<ArtifactDeletePayload> extends true
      ? PayloadHasForbiddenKey<ArtifactCleanPayload> extends true
        ? PayloadHasForbiddenKey<ArtifactDecisionPayload> extends true
          ? PayloadHasForbiddenKey<ArtifactRelocatePayload> extends true
            ? PayloadHasForbiddenKey<ArtifactDefaultDirPayload> extends true
              ? true
              : false
            : false
          : false
        : false
      : false
    : false
>

export type ArtifactApiTypecheck = ArtifactApiGuard

// @ts-expect-error renderer must not pass workspace root to artifact:list
const _badList: ArtifactListPayload = { sessionId: 's1', workDir: '/tmp' }

// @ts-expect-error renderer must not pass workspace root to artifact:delete
const _badDelete: ArtifactDeletePayload = { sessionId: 's1', artifactId: 'a1', workspaceRoot: '/tmp' }
