import { getDbConnection, type AppDatabase } from '../database'

export function registerReferenceMetadata(db: AppDatabase, input: {
  artifactId: string
  title?: string
  url?: string
  fetchedAt: number
  accessNote?: string
  licenseNote?: string
}): { complete: true } | { complete: false; missing: ('title' | 'url')[] } {
  const missing = (['title', 'url'] as const).filter((field) => !input[field])
  if (missing.length) return { complete: false, missing }
  getDbConnection(db).prepare(`INSERT INTO artifact_references (
    artifact_id, source_title, source_url, fetched_at, access_note, license_note
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(artifact_id) DO UPDATE SET source_title=excluded.source_title, source_url=excluded.source_url,
    fetched_at=excluded.fetched_at, access_note=excluded.access_note, license_note=excluded.license_note`)
    .run(input.artifactId, input.title, input.url, input.fetchedAt, input.accessNote ?? null, input.licenseNote ?? null)
  return { complete: true }
}
