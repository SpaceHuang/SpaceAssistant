import type { AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { readImPolicySnapshot } from '../confirmation/imPolicyStore'
import type { ImPolicyPromptSnapshot } from '../../src/shared/policy/policyPromptContext'

/** Read the one shared IM policy used to describe the current gate to either remote channel. */
export function readImPromptPolicySnapshot(db: AppDatabase): ImPolicyPromptSnapshot | undefined {
  try {
    return readImPolicySnapshot(getDbConnection(db), {
      supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2']
    })
  } catch {
    return undefined
  }
}
