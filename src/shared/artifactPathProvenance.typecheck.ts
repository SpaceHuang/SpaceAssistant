import type { ArtifactPathProvenance } from './artifactTypes'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false
type Expect<Value extends true> = Value

type UserMember = Expect<Equal<Extract<ArtifactPathProvenance, { pathSource: 'user' }>, {
  pathSource: 'user'
  pathEvidenceId: string
  pathDecisionId?: never
}>>
type UserDecisionMember = Expect<Equal<Extract<ArtifactPathProvenance, { pathSource: 'user-decision' }>, {
  pathSource: 'user-decision'
  pathDecisionId: string
  pathEvidenceId?: never
}>>

export type ArtifactPathProvenanceTypecheck = UserMember | UserDecisionMember
