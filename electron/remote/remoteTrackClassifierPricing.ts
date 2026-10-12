import { getConfigValue, type AppDatabase } from '../database'
import { getModelIntentAttributorClassifierVersion } from './modelIntentAttributor'
import { isRemoteTrackPricingEvidence, type RemoteTrackPricingEvidence } from '../../src/shared/remoteTrackPricingEvidence'

export const REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY = 'remoteTrackClassifierPricingUsdPerMillionV2'

export type RemoteTrackClassifierRates = Readonly<{
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cacheReadInputUsdPerMillion: number
  cacheCreationInputUsdPerMillion: number
}>

export type RemoteTrackClassifierUsage = Readonly<{
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}>

export type RemoteTrackClassifierPricingEvidence = RemoteTrackPricingEvidence

export type RemoteTrackClassifierPricingConfig = Readonly<{
  version: 2
  ratesByClassifierVersion: Readonly<Record<string, RemoteTrackClassifierRates>>
  evidenceByClassifierVersion: Readonly<Record<string, RemoteTrackClassifierPricingEvidence>>
}>

export type RemoteTrackClassifierCostEstimator = ((usage: RemoteTrackClassifierUsage) => number | null) &
  Readonly<{ pricingEvidence: RemoteTrackClassifierPricingEvidence }>

function validRates(value: unknown): value is RemoteTrackClassifierRates {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const expected = ['inputUsdPerMillion', 'outputUsdPerMillion', 'cacheReadInputUsdPerMillion', 'cacheCreationInputUsdPerMillion']
  return Object.keys(row).length === expected.length && expected.every((key) => Object.hasOwn(row, key) &&
    typeof row[key] === 'number' && Number.isFinite(row[key]) && (row[key] as number) >= 0)
}

export function parseRemoteTrackClassifierPricingConfig(value: unknown): RemoteTrackClassifierPricingConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const root = value as Record<string, unknown>
  if (Object.keys(root).length !== 3 || root.version !== 2 || typeof root.ratesByClassifierVersion !== 'object' ||
    root.ratesByClassifierVersion === null || Array.isArray(root.ratesByClassifierVersion) ||
    typeof root.evidenceByClassifierVersion !== 'object' || root.evidenceByClassifierVersion === null || Array.isArray(root.evidenceByClassifierVersion)) return null
  const rates = root.ratesByClassifierVersion as Record<string, unknown>
  const evidence = root.evidenceByClassifierVersion as Record<string, unknown>
  const versions = Object.keys(rates)
  if (versions.length === 0 || versions.length !== Object.keys(evidence).length ||
    Object.entries(rates).some(([version, rate]) => !/^chat-[a-f0-9]{16}$/.test(version) || !validRates(rate) || !isRemoteTrackPricingEvidence(evidence[version])) ||
    Object.keys(evidence).some((version) => !Object.hasOwn(rates, version))) return null
  return root as unknown as RemoteTrackClassifierPricingConfig
}

/** Loads an operator-supplied USD rate card keyed by opaque classifier version. */
export function readRemoteTrackClassifierRates(db: AppDatabase, input: { baseUrl: string; model: string }): RemoteTrackClassifierRates | null {
  const raw = getConfigValue(db, REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY)
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  const version = getModelIntentAttributorClassifierVersion(input.baseUrl, input.model)
  const config = parseRemoteTrackClassifierPricingConfig(parsed)
  return config?.ratesByClassifierVersion[version] ?? null
}

export function readRemoteTrackClassifierPricing(db: AppDatabase, input: { baseUrl: string; model: string }):
  { rates: RemoteTrackClassifierRates; evidence: RemoteTrackClassifierPricingEvidence } | null {
  const raw = getConfigValue(db, REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY)
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  const version = getModelIntentAttributorClassifierVersion(input.baseUrl, input.model)
  const config = parseRemoteTrackClassifierPricingConfig(parsed)
  const rates = config?.ratesByClassifierVersion[version]
  const evidence = config?.evidenceByClassifierVersion[version]
  return rates && evidence ? { rates, evidence } : null
}

export function estimateRemoteTrackClassifierCostUsd(rates: RemoteTrackClassifierRates, usage: RemoteTrackClassifierUsage): number | null {
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) return null
  const cost = (usage.inputTokens * rates.inputUsdPerMillion + usage.outputTokens * rates.outputUsdPerMillion +
    usage.cacheReadInputTokens * rates.cacheReadInputUsdPerMillion + usage.cacheCreationInputTokens * rates.cacheCreationInputUsdPerMillion) / 1_000_000
  return Number.isFinite(cost) ? cost : null
}

export function createRemoteTrackClassifierCostEstimator(db: AppDatabase, input: { baseUrl: string; model: string }):
  RemoteTrackClassifierCostEstimator | undefined {
  const pricing = readRemoteTrackClassifierPricing(db, input)
  return pricing ? Object.assign((usage: RemoteTrackClassifierUsage) => estimateRemoteTrackClassifierCostUsd(pricing.rates, usage),
    { pricingEvidence: pricing.evidence }) : undefined
}
