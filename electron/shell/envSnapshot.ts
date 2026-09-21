import { createHash } from 'crypto'

export interface EnvSnapshotForLog {
  /** 环境变量键数量（不含 undefined 值的键）。 */
  keyCount: number
  /** 排序后键集合的 SHA-256。 */
  keysSha256: string
  /** 排序后 [键, 值哈希] 条目的 SHA-256：值永不出现，等价性可比对。 */
  entriesSha256: string
  /** 键 → 值哈希（供 diff 定位变化的键；值本身不进入）。 */
  valueHashByKey: Record<string, string>
}

/**
 * P0-D3 组 5（§5.4.3）：env 完整快照——键集合 + 脱敏后逐键哈希。
 * run_shell 与 run_script 各记一份，双路径 env 是否逐键等价可事后比对；
 * 秘密（环境变量值）只以哈希形态出现，永不落日志。
 */
export function snapshotEnvForLog(env: NodeJS.ProcessEnv): EnvSnapshotForLog {
  const valueHashByKey: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    valueHashByKey[key] = createHash('sha256').update(value).digest('hex')
  }
  const keys = Object.keys(valueHashByKey).sort()
  return {
    keyCount: keys.length,
    keysSha256: createHash('sha256').update(JSON.stringify(keys)).digest('hex'),
    entriesSha256: createHash('sha256')
      .update(JSON.stringify(keys.map((key) => [key, valueHashByKey[key]])))
      .digest('hex'),
    valueHashByKey
  }
}

export interface EnvDiffSummary {
  identical: boolean
  keysOnlyInA: string[]
  keysOnlyInB: string[]
  /** 键集合相同但值哈希不同的键（值本身不出现）。 */
  valueChangedKeys: string[]
}

/** 双路径 env 快照 diff：只输出键名与等价性结论。 */
export function diffEnvSnapshots(a: EnvSnapshotForLog, b: EnvSnapshotForLog): EnvDiffSummary {
  const keysOnlyInA: string[] = []
  const keysOnlyInB: string[] = []
  const valueChangedKeys: string[] = []
  for (const key of Object.keys(a.valueHashByKey)) {
    if (!(key in b.valueHashByKey)) keysOnlyInA.push(key)
    else if (a.valueHashByKey[key] !== b.valueHashByKey[key]) valueChangedKeys.push(key)
  }
  for (const key of Object.keys(b.valueHashByKey)) {
    if (!(key in a.valueHashByKey)) keysOnlyInB.push(key)
  }
  return {
    identical: keysOnlyInA.length === 0 && keysOnlyInB.length === 0 && valueChangedKeys.length === 0,
    keysOnlyInA: keysOnlyInA.sort(),
    keysOnlyInB: keysOnlyInB.sort(),
    valueChangedKeys: valueChangedKeys.sort()
  }
}
