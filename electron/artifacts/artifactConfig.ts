import { getConfigValue, type AppDatabase } from '../database'

export const ARTIFACT_MANAGEMENT_CONFIG_KEY = 'config.artifactManagementEnabled'

export function readArtifactManagementEnabledFromConfig(db: AppDatabase): boolean {
  return getConfigValue(db, ARTIFACT_MANAGEMENT_CONFIG_KEY) === 'true'
}
