import { deleteConfigValue, getConfigValue, setConfigValue, type AppDatabase } from '../database'
import {
  scratchGitPolicyConfigKey,
  type ScratchGitSavedPolicy
} from './scratchGitPolicy'

export { scratchGitPolicyConfigKey }

export function readScratchGitPolicyPreference(db: AppDatabase, profileId: string): ScratchGitSavedPolicy | undefined {
  const value = getConfigValue(db, scratchGitPolicyConfigKey(profileId))
  if (value === 'add-ignore' || value === 'keep-visible') return value
  return undefined
}

export function writeScratchGitPolicyPreference(
  db: AppDatabase,
  profileId: string,
  policy: ScratchGitSavedPolicy | undefined
): void {
  const key = scratchGitPolicyConfigKey(profileId)
  if (!policy) {
    deleteConfigValue(db, key)
    return
  }
  setConfigValue(db, key, policy)
}
