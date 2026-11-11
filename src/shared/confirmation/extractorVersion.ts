/** Canonical invocation-wide version identity for the facts producers that ran this turn. */
export function createInvocationExtractorVersion(components: Readonly<Record<string, string>>): string {
  const entries = Object.entries(components)
  if (entries.some(([id, version]) => !id.trim() || !version.trim())) throw new Error('EXTRACTOR_VERSION_COMPONENT_INVALID')
  return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))))
}
