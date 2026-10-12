export type RemoteTrackPricingEvidence = Readonly<{
  sourceUrl: string
  effectiveAt: string
  verifiedAt: string
  verifiedBy: string
}>

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Validates the auditable, non-secret provenance stored beside a classifier cost estimate. */
export function isRemoteTrackPricingEvidence(value: unknown): value is RemoteTrackPricingEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 4 || typeof row.sourceUrl !== 'string' || typeof row.effectiveAt !== 'string' ||
    typeof row.verifiedAt !== 'string' || typeof row.verifiedBy !== 'string' || row.sourceUrl.length > 2_048 ||
    !validIsoDate(row.effectiveAt) || !validIsoDate(row.verifiedAt) || row.verifiedAt < row.effectiveAt ||
    row.verifiedBy.trim().length === 0 || row.verifiedBy.trim().length > 80) return false
  try {
    const source = new URL(row.sourceUrl)
    return source.protocol === 'https:' && source.hostname.length > 0 && !source.username && !source.password &&
      !source.search && !source.hash
  } catch { return false }
}
