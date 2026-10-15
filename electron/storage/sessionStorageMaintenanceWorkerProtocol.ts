/**
 * 主进程编排器与压缩 worker 之间的消息契约（两端共用，勿在单端重复定义）。
 * phase 取值与 StorageMaintenanceProgress 对齐（'swap' 阶段由编排器在临界区前发出，worker 只发 archive/vacuum）。
 */

export type SessionMaintenanceWorkerPhase = 'archive' | 'vacuum'

export type SessionMaintenanceWorkerRequest = Readonly<{
  dbPath: string
  archivePath: string
  spillRoot: string
  degradedSpillRoot: string
  stagingPath: string
}>

export type SessionMaintenanceWorkerProgressMessage = Readonly<{
  type: 'progress'
  phase: SessionMaintenanceWorkerPhase
  completedBytes: number
  totalBytes: number
}>

export type SessionMaintenanceWorkerResultMessage = Readonly<{
  type: 'result'
  dbSourceSha256: string
  dbDestSha256: string
  spillSourceManifest: string[]
  spillDegradedSourceManifest: string[]
  archiveBytes: number
  stagingBytes: number
  dataVersionBefore: number
  dataVersionAfter: number
  stageDurationsMs: { archive: number; verify: number; vacuum: number }
}>

export type SessionMaintenanceWorkerErrorMessage = Readonly<{ type: 'error'; code: string; message: string }>

/** watchdog 心跳：长同步阶段（回读哈希 chunk 边界、quick_check 发起前）发出，client 仅续期不转发。 */
export type SessionMaintenanceWorkerHeartbeatMessage = Readonly<{ type: 'heartbeat' }>

export type SessionMaintenanceWorkerMessage =
  | SessionMaintenanceWorkerProgressMessage
  | SessionMaintenanceWorkerResultMessage
  | SessionMaintenanceWorkerErrorMessage
  | SessionMaintenanceWorkerHeartbeatMessage
