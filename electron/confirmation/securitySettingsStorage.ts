import type { AppDatabase } from '../database'
import { getDbConnection } from '../database'
import type { CacheKey } from '../../src/shared/confirmation/types'
import { PolicyRuleStore, type PolicyRuleOverride } from './policyRuleStore'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { commitDesktopPolicySnapshot, readPolicyBehaviorSnapshot } from './imPolicyStore'

/** Security settings persistence adapter. It is the only owner that binds rule/cache stores to SQLite. */
export function createSecuritySettingsStorage(db: AppDatabase) {
  const ruleStore = () => new PolicyRuleStore(getDbConnection(db))
  const decisionCache = () => new SqliteDecisionCache(getDbConnection(db))
  return Object.freeze({
    readDesktopPolicySnapshot: (): { revision: number; snapshot: Record<string, unknown> } => {
      try { return readPolicyBehaviorSnapshot(getDbConnection(db), 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }) }
      catch { return { revision: 0, snapshot: { selectedPackage: 'standard', ruleOverrides: {} } } }
    },
    commitDesktopPolicySnapshot: (input: Parameters<typeof commitDesktopPolicySnapshot>[1]) => commitDesktopPolicySnapshot(getDbConnection(db), input),
    listImPolicyAuditEvents: () => getDbConnection(db).prepare(
      "SELECT event_json FROM policy_audit_events WHERE domain='im' ORDER BY rowid DESC LIMIT 500"
    ).all() as Array<{ event_json: string }>,
    listRuleOverrides: () => ruleStore().listOverrides(),
    getOverride: (ruleId: string) => ruleStore().getOverride(ruleId),
    setOverride: (override: PolicyRuleOverride) => ruleStore().setOverride(override),
    removeOverride: (ruleId: string) => ruleStore().removeOverride(ruleId),
    listDecisionCache: () => decisionCache().list(),
    clearDecisionCache: (key: CacheKey) => decisionCache().clear(key),
    clearAllDecisionCache: () => decisionCache().clearAll()
  })
}
