import type { ProjectionBuildOutputManifestRef } from '../domain/projectionBuild'

export type ProjectionOutputBlobReader = Readonly<{
  readVerified(input: ProjectionBuildOutputManifestRef): Promise<string>
}>

export type ProjectionMaterializedMessage = Readonly<{ role: string; content: unknown; id?: string }>
export type ProjectionOutputIdentity = Readonly<{
  sessionId: string
  sessionGeneration: string
  scopeKey: string
  specVersion: number
  sourceIdentityJson: string
}>

export async function materializeProjectionOutputManifest(
  root: ProjectionBuildOutputManifestRef,
  identity: ProjectionOutputIdentity,
  blobs: ProjectionOutputBlobReader
): Promise<readonly ProjectionMaterializedMessage[]> {
  const chain: Array<Readonly<{ outputManifest: { parent: ProjectionBuildOutputManifestRef | null; operations: readonly unknown[] } }>> = []
  const seen = new Set<string>()
  let current: ProjectionBuildOutputManifestRef | null = root
  while (current) {
    if (seen.has(current.locator)) throw new Error('PROJECTION_OUTPUT_MANIFEST_CYCLE')
    seen.add(current.locator)
    const payload = await blobs.readVerified(current)
    let value: unknown
    try { value = JSON.parse(payload) } catch { throw new Error('PROJECTION_OUTPUT_MANIFEST_INVALID_JSON') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PROJECTION_OUTPUT_MANIFEST_INVALID')
    const node = value as Record<string, unknown>
    if (node.formatVersion !== 2 || node.sessionId !== identity.sessionId || node.sessionGeneration !== identity.sessionGeneration ||
      node.scopeKey !== identity.scopeKey || node.specVersion !== identity.specVersion || node.sourceIdentityJson !== identity.sourceIdentityJson) {
      throw new Error('PROJECTION_OUTPUT_MANIFEST_IDENTITY_MISMATCH')
    }
    const manifest = node.outputManifest as { formatVersion?: unknown; parent?: unknown; operations?: unknown } | undefined
    if (!manifest || manifest.formatVersion !== 1 || !Array.isArray(manifest.operations)) throw new Error('PROJECTION_OUTPUT_MANIFEST_SHAPE_INVALID')
    chain.push({ outputManifest: manifest as { parent: ProjectionBuildOutputManifestRef | null; operations: readonly unknown[] } })
    const parent = manifest.parent
    if (parent === null) current = null
    else if (!parent || typeof parent !== 'object' || typeof (parent as ProjectionBuildOutputManifestRef).locator !== 'string' ||
      !Number.isSafeInteger((parent as ProjectionBuildOutputManifestRef).byteLength) ||
      !/^[a-f0-9]{64}$/.test((parent as ProjectionBuildOutputManifestRef).payloadDigest)) throw new Error('PROJECTION_OUTPUT_MANIFEST_PARENT_INVALID')
    else current = parent as ProjectionBuildOutputManifestRef
  }

  let messages: ProjectionMaterializedMessage[] = []
  for (const node of chain.reverse()) {
    for (const candidate of node.outputManifest.operations) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('PROJECTION_OUTPUT_OPERATION_INVALID')
      const operation = candidate as { type?: unknown; messages?: unknown }
      if ((operation.type !== 'append' && operation.type !== 'replace') || !Array.isArray(operation.messages) ||
        operation.messages.some((message) => !message || typeof message !== 'object' || Array.isArray(message) ||
          typeof (message as ProjectionMaterializedMessage).role !== 'string' || !Object.hasOwn(message, 'content'))) {
        throw new Error('PROJECTION_OUTPUT_OPERATION_INVALID')
      }
      if (operation.type === 'replace') messages = []
      messages.push(...structuredClone(operation.messages) as ProjectionMaterializedMessage[])
    }
  }
  return Object.freeze(messages)
}
