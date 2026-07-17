import type { ArtifactContainer } from './artifactTypes'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false
type Expect<Value extends true> = Value

type ArtifactContainerIsExact = Expect<Equal<ArtifactContainer, 'project' | 'package' | 'scratch'>>

export type ArtifactContainerTypecheck = ArtifactContainerIsExact
