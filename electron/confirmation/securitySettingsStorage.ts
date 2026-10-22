import type { AppDatabase } from '../database'
import { getDbConnection } from '../database'
import type { CacheKey } from '../../src/shared/confirmation/types'
import { PolicyRuleStore, type PolicyRuleOverride } from './policyRuleStore'
import { SqliteDecisionCache } from './sqliteDecisionCache'

/** Security settings persistence adapter. It is the only owner that binds rule/cache stores to SQLite. */
export function createSecuritySettingsStorage(db: AppDatabase) {
  const ruleStore = () => new PolicyRuleStore(getDbConnection(db))
  const decisionCache = () => new SqliteDecisionCache(getDbConnection(db))
  return Object.freeze({
    listRuleOverrides: () => ruleStore().listOverrides(),
    getOverride: (ruleId: string) => ruleStore().getOverride(ruleId),
    setOverride: (override: PolicyRuleOverride) => ruleStore().setOverride(override),
    removeOverride: (ruleId: string) => ruleStore().removeOverride(ruleId),
    listDecisionCache: () => decisionCache().list(),
    clearDecisionCache: (key: CacheKey) => decisionCache().clear(key),
    clearAllDecisionCache: () => decisionCache().clearAll()
  })
}
