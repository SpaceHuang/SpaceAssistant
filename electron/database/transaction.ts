import type { DatabaseSync } from 'node:sqlite'

/**
 * 连接级事务入口（唯一事务边界来源；业务代码不得自行发出 BEGIN/COMMIT/SAVEPOINT）。
 *
 * 独立成模块而非放在 sqliteStore.ts，是因为 sqliteStore → migrations → 事务 helper
 * 存在循环依赖，ESM/vite SSR 下循环边缘可能拿到半初始化的命名空间。
 *
 * - 最外层：BEGIN / COMMIT，回调抛错时 ROLLBACK 后重抛原错误。
 * - 嵌套：每连接单调递增 SAVEPOINT 名；成功 RELEASE，失败 ROLLBACK TO + RELEASE 后重抛。
 * - 同步回调契约：回调返回 Promise/thenable 时回滚并抛错，杜绝提交后继续写入。
 */

type TransactionState = {
  /** 当前事务嵌套深度（>0 表示处于事务中） */
  depth: number
  /** 每连接单调递增的 savepoint 序号，保证名称唯一 */
  seq: number
}

/** 事务状态按连接隔离；连接关闭后 WeakMap 条目随连接回收，不保留状态。 */
const txStates = new WeakMap<DatabaseSync, TransactionState>()

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export function runInTransaction<T>(conn: DatabaseSync, fn: () => T): T {
  let state = txStates.get(conn)
  if (!state) {
    state = { depth: 0, seq: 0 }
    txStates.set(conn, state)
  }

  if (state.depth === 0) {
    conn.exec('BEGIN')
    state.depth = 1
    try {
      const result = fn()
      if (isThenable(result)) {
        throw new Error('runInTransaction does not accept async/Promise callbacks; use a synchronous callback')
      }
      conn.exec('COMMIT')
      return result
    } catch (err) {
      conn.exec('ROLLBACK')
      throw err
    } finally {
      state.depth = 0
    }
  }

  const savepoint = `sa_tx_sp_${++state.seq}`
  conn.exec(`SAVEPOINT ${savepoint}`)
  state.depth++
  try {
    const result = fn()
    if (isThenable(result)) {
      throw new Error('runInTransaction does not accept async/Promise callbacks; use a synchronous callback')
    }
    conn.exec(`RELEASE SAVEPOINT ${savepoint}`)
    return result
  } catch (err) {
    conn.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    conn.exec(`RELEASE SAVEPOINT ${savepoint}`)
    throw err
  } finally {
    state.depth--
  }
}

/**
 * `StatementSync.run()` 的 `lastInsertRowid` 在 node:sqlite 中为 `number | bigint`；
 * 进入既有 number 领域模型前必须显式转换，超出安全整数范围抛错，不做静默精度丢失。
 */
export function lastInsertRowidToNumber(value: number | bigint): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`lastInsertRowid ${value} is not a safe integer`)
    return value
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`lastInsertRowid ${value} exceeds the safe integer range`)
  }
  return Number(value)
}
