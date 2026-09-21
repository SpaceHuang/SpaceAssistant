import { getConfigValue, setConfigValue, type AppDatabase } from '../database'
import { runInTransaction } from '../database/transaction'
import { getDbConnection } from '../database'
import {
  DEFAULT_ADMISSION_POLICY,
  emptyAdmissionState,
  type AdmissionPolicy,
  type AdmissionState
} from '../runtime/callAdmission'

/**
 * 调用级准入——Storage 状态与可配策略(B1 0a,偏差 23;基线依赖纪律 4「准入在 Runtime、配额状态在 Storage」)。
 * - 状态(configs 表 `admission.state` JSON)跨重启不丢;读写走 runInTransaction;
 * - 启动维护清零「活跃计数」段(进程已终止,票据不再有效),保留速率窗口与配额计数(防重启绕过限流);
 * - 策略参数可配(`admission.policy.*`),显式默认(缺配置 = 显式声明的默认,非代码常量兜底);
 *   automation lane 首批配置数据化吸收原 butlerAdmission(并发 1 + 每小时 30)。
 */

const STATE_KEY = 'admission.state'

const POLICY_CONFIG_KEYS = {
  globalMaxConcurrent: 'admission.policy.globalMaxConcurrent',
  backgroundMaxConcurrent: 'admission.policy.backgroundMaxConcurrent',
  globalHourlyStarts: 'admission.policy.globalHourlyStarts',
  queueLimit: 'admission.policy.queueLimit',
  approvalReservedSlots: 'admission.policy.approvalReservedSlots'
} as const

/** 读取可配策略覆盖(缺省/非法值收敛显式默认,fail-closed)。 */
export function resolveAdmissionPolicy(db: AppDatabase): AdmissionPolicy {
  const policy: AdmissionPolicy = structuredClone(DEFAULT_ADMISSION_POLICY)
  const overrides: Array<[string, (v: number) => void]> = [
    [POLICY_CONFIG_KEYS.globalMaxConcurrent, (v) => { policy.globalMaxConcurrent = v }],
    [POLICY_CONFIG_KEYS.backgroundMaxConcurrent, (v) => { policy.backgroundMaxConcurrent = Math.min(v, policy.globalMaxConcurrent) }],
    [POLICY_CONFIG_KEYS.globalHourlyStarts, (v) => { policy.globalHourlyStarts = v }],
    [POLICY_CONFIG_KEYS.queueLimit, (v) => { policy.queueLimit = v }],
    [POLICY_CONFIG_KEYS.approvalReservedSlots, (v) => { policy.approvalReservedSlots = v }]
  ]
  for (const [key, apply] of overrides) {
    const raw = getConfigValue(db, key)
    const value = Number(raw)
    if (raw !== undefined && raw !== '' && Number.isInteger(value) && value >= 0) apply(value)
  }
  policy.globalMaxConcurrent = Math.max(1, policy.globalMaxConcurrent)
  policy.backgroundMaxConcurrent = Math.max(1, policy.backgroundMaxConcurrent)
  policy.globalHourlyStarts = Math.max(1, policy.globalHourlyStarts)
  return policy
}

/** 读状态(缺省 = 空状态;损坏 JSON 收敛空状态,fail-closed)。 */
export function loadAdmissionState(db: AppDatabase, now: number): AdmissionState {
  const raw = getConfigValue(db, STATE_KEY)
  if (!raw) return emptyAdmissionState(now)
  try {
    const parsed = JSON.parse(raw) as AdmissionState
    if (
      typeof parsed.activeInteractive !== 'number' ||
      typeof parsed.activeBackground !== 'number' ||
      !parsed.laneActive ||
      !parsed.laneWindowStarts ||
      typeof parsed.windowStart !== 'number' ||
      typeof parsed.windowStarts !== 'number' ||
      typeof parsed.queued !== 'number'
    ) {
      return emptyAdmissionState(now)
    }
    return parsed
  } catch {
    return emptyAdmissionState(now)
  }
}

/** 写状态(事务)。 */
export function saveAdmissionState(db: AppDatabase, state: AdmissionState): void {
  runInTransaction(getDbConnection(db), () => {
    setConfigValue(db, STATE_KEY, JSON.stringify(state))
  })
}

/** 启动维护:清零活跃计数(票据随进程终止失效),保留速率窗口与配额计数。 */
export function resetActiveAdmissionOnStartup(db: AppDatabase, now: number): void {
  const state = loadAdmissionState(db, now)
  saveAdmissionState(db, {
    ...state,
    activeInteractive: 0,
    activeBackground: 0,
    laneActive: { desktop: 0, wechat: 0, feishu: 0, automation: 0 },
    queued: 0
  })
}
