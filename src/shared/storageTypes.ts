export type StorageMaintenanceProgress = Readonly<{
  phase: 'archive' | 'vacuum' | 'reclaim' | 'complete'
  completedPages?: number
  remainingPages?: number
  /** 字节级真实进度（archive 阶段复制进度；P5 起 swap 阶段轮询 staging 字节）。缺省时 UI 回落阶段档位。 */
  completedBytes?: number
  totalBytes?: number
}>

export type StorageMetric = Readonly<{ rows: number; textBytes: number }>
export type StorageMeasurement = Readonly<{ files: number; observedBytes: number; totalBytes: number | null; complete: boolean; errorCodes: readonly string[] }>
export type StorageSpillClassification = Readonly<{
  files: number
  observedBytes: number
  totalBytes: number | null
  classification: 'complete' | 'unknown'
  sourceOfTruthBytes: number | null
  degradableBytes: number | null
  orphanBytes: number | null
  complete: boolean
  errorCodes: readonly string[]
}>

/** Structured-cloneable size overview. Unknown numeric measurements use null. */
export type StorageOverview = Readonly<{
  collectedAt: string
  status: 'complete' | 'partial' | 'failed'
  totalBytes: number | null
  database: Readonly<{ dbBytes: number | null; walBytes: number | null; shmBytes: number | null; complete: boolean }>
  spill: StorageSpillClassification
  spillDegraded: StorageMeasurement
  pendingGc: Readonly<{ files: number | null; bytes: number | null; complete: boolean }>
  tables: Readonly<{ messages: StorageMetric | null }>
}>

export type StorageAuditCoverage = Readonly<Record<string, number | Readonly<Record<string, number>> | null>>
export type StorageMessageBodyCoverage = Readonly<{
  messages: number
  bodyMatched: number
  byRole: Readonly<Record<string, Readonly<{ messages: number; bodyMatched: number }>>>
  identityBodyCandidateCount: number
  identityBodyCandidateBytes: number
  identityBodyCandidatesByRole: Readonly<Record<string, Readonly<{ messages: number; candidateMatches: number; candidateContentBytes: number }>>>
  canonicalIdentityCount: number
  canonicalUniqueBodies: number
  malformedPayloads: number
}>
/** Strict diagnostic result; intentionally excludes raw descriptors and all content. */
export type StorageAudit = Readonly<{
  collectedAt: string
  status: 'pending' | 'complete' | 'partial' | 'failed'
  errorCodes: readonly string[]
  canonicalCoverage: StorageAuditCoverage | null
  canonicalSessionCoverage: StorageAuditCoverage | null
  canonicalRequiredData: Readonly<{ eventRows: number; eventPayloadBytes: number; streamRows: number; streamTableBytes: number | null }> | null
  messageBodyCoverage: StorageMessageBodyCoverage | null
  strictSpillReferences: Readonly<{ complete: boolean; descriptors: number | null; uniqueLocators: number | null; errorCodes: readonly string[] }> | null
}>

/** Full legacy diagnostic shape retained for existing local scripts and estimates. */
export type StorageStrictProfile = Readonly<Record<string, unknown> & { collectedAt: string }>
