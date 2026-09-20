import { getDbConnection, type AppDatabase } from './index'

/**
 * 偏差 11:scope 版本号——失效通知的权威版本源。
 * 业务写路径在**同一事务内**递增(Storage 在事务内递增,回滚随之回滚);
 * 广播合并到微任务:同 scope 多次递增只广播一次、版本取最新(提交后广播)。
 */

let broadcaster: ((scope: string, version: number) => void) | null = null

export function setInvalidationBroadcaster(fn: (scope: string, version: number) => void): void {
  broadcaster = fn
}

export function resetInvalidationBroadcaster(): void {
  broadcaster = null
}

/** 事务内递增:必须在业务事务(或独立自洽写)中调用;返回递增后的版本 */
export function bumpScopeVersionInTx(db: AppDatabase, scope: string): number {
  const conn = getDbConnection(db)
  conn
    .prepare(
      'INSERT INTO scope_versions (scope, version) VALUES (?, 1) ON CONFLICT(scope) DO UPDATE SET version = version + 1'
    )
    .run(scope)
  const row = conn.prepare('SELECT version FROM scope_versions WHERE scope = ?').get(scope) as
    | { version: number }
    | undefined
  const version = row?.version ?? 0
  scheduleBroadcast(db, scope)
  return version
}

export function getScopeVersion(db: AppDatabase, scope: string): number {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT version FROM scope_versions WHERE scope = ?').get(scope) as
    | { version: number }
    | undefined
  return row?.version ?? 0
}

// ---- 提交后合并广播(node:sqlite 同步事务:提交先于微任务执行)----

const dirtyByDb = new Map<AppDatabase, Set<string>>()
let scheduled = false

function scheduleBroadcast(db: AppDatabase, scope: string): void {
  let set = dirtyByDb.get(db)
  if (!set) {
    set = new Set()
    dirtyByDb.set(db, set)
  }
  set.add(scope)
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    for (const [dbRef, scopes] of dirtyByDb) {
      const snapshot = [...scopes]
      scopes.clear()
      if (scopes.size === 0) dirtyByDb.delete(dbRef)
      for (const scope of snapshot) {
        try {
          broadcaster?.(scope, getScopeVersion(dbRef, scope))
        } catch {
          // 库可能已关闭(测试收尾);广播失败不影响写路径
        }
      }
    }
  })
}
