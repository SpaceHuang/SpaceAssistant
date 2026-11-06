/** Why a persisted desktop queue should be observed again. */
export type OutboundDrainWakeReason =
  | 'external'
  | 'queue-enqueued'
  | 'turn-terminal'
  | 'capacity-released'
  | 'compaction-released'
  | 'retry-timer'
  | 'persistence-retry'
  | 'startup-recovery'
