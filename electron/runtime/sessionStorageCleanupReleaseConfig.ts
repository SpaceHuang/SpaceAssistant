import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { SessionStorageCleanupReleaseGateInput, SessionStorageCleanupCompatibilityRecord } from './sessionStorageCleanupReleaseGate'

const BUILD_IDENTITY_FILE = 'session-storage-build-identity.json'
const DEPLOYMENT_CONFIG_FILE = 'session-storage-cleanup-deployment.json'
const COMPATIBILITY_RECORD_FILE = 'session-storage-cleanup-compatibility.json'

/** Bump these when persisted canonical History events or the source-spill envelope changes incompatibly. */
export const SESSION_STORAGE_HISTORY_FORMAT_VERSION = 1
export const SESSION_STORAGE_SPILL_FORMAT_VERSION = 1

export type ReadSessionStorageCleanupReleaseGateInputOptions = Readonly<{
  resourcesPath: string
  appVersion: string
  schemaVersion: number
  historyFormatVersion: number
  spillFormatVersion: number
  platform: string
  arch: string
  readFile?: (filePath: string) => string
}>

type PackagedBuildIdentity = Readonly<{
  formatVersion?: unknown
  version?: unknown
  commitSha?: unknown
  sourceTreeClean?: unknown
  buildId?: unknown
  target?: Readonly<{ platform?: unknown; arch?: unknown }>
}>

type PackagedDeploymentConfig = Readonly<{
  formatVersion?: unknown
  allowContentCleanup?: unknown
  compatibilityRecordSha256?: unknown
}>

function readJson(readFile: (filePath: string) => string, resourcesPath: string, fileName: string): unknown {
  try {
    return JSON.parse(readFile(path.join(resourcesPath, fileName))) as unknown
  } catch {
    return undefined
  }
}

function normalizePlatform(platform: string): string {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'win'
  return platform
}

/**
 * Loads only packaged release metadata. Missing, malformed, dirty-build, and mismatched-version
 * inputs are represented as unusable values so the policy gate remains closed.
 */
export function readSessionStorageCleanupReleaseGateInput(
  options: ReadSessionStorageCleanupReleaseGateInputOptions,
): SessionStorageCleanupReleaseGateInput {
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, 'utf8'))
  const identity = readJson(readFile, options.resourcesPath, BUILD_IDENTITY_FILE) as PackagedBuildIdentity | undefined
  const expectedPlatform = normalizePlatform(options.platform)
  const identityMatchesTarget = identity?.target?.platform === expectedPlatform && identity.target.arch === options.arch
  const identityHasBuildId = typeof identity?.buildId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.buildId)
  const commitSha = identity?.formatVersion === 2 && identity.version === options.appVersion && identity.sourceTreeClean === true &&
    identityHasBuildId && identityMatchesTarget &&
    typeof identity.commitSha === 'string' && /^[a-f0-9]{40}$/i.test(identity.commitSha)
    ? identity.commitSha
    : ''

  const rawDeployment = readJson(readFile, options.resourcesPath, DEPLOYMENT_CONFIG_FILE) as PackagedDeploymentConfig | undefined
  const deployment = rawDeployment?.formatVersion === 1 && rawDeployment.allowContentCleanup === true &&
    typeof rawDeployment.compatibilityRecordSha256 === 'string'
    ? {
        allowContentCleanup: true,
        compatibilityRecordSha256: rawDeployment.compatibilityRecordSha256,
      }
    : { allowContentCleanup: false, compatibilityRecordSha256: null }

  const rawRecord = readJson(readFile, options.resourcesPath, COMPATIBILITY_RECORD_FILE)
  const record = rawRecord !== null && typeof rawRecord === 'object' && !Array.isArray(rawRecord)
    ? rawRecord as SessionStorageCleanupCompatibilityRecord
    : undefined

  return {
    currentBuild: {
      version: options.appVersion,
      commitSha,
      schemaVersion: options.schemaVersion,
      historyFormatVersion: options.historyFormatVersion,
      spillFormatVersion: options.spillFormatVersion,
    },
    target: { platform: expectedPlatform, arch: options.arch },
    deployment,
    record,
  }
}
