export type StorageMaintenanceProgress = Readonly<{
  phase: 'archive' | 'vacuum' | 'reclaim' | 'complete'
  completedPages?: number
  remainingPages?: number
}>
