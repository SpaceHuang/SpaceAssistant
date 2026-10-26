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
      const operation = candidate as { type?: unknown; messages?: unknown; updates?: unknown }
      if (operation.type === 'appendText') {
        if (!Array.isArray(operation.updates) || operation.updates.some((update) => !update || typeof update !== 'object' || Array.isArray(update) ||
          typeof (update as { id?: unknown }).id !== 'string' || !(update as { id: string }).id.trim() ||
          (update as { role?: unknown }).role !== 'assistant' || typeof (update as { text?: unknown }).text !== 'string')) {
          throw new Error('PROJECTION_OUTPUT_OPERATION_INVALID')
        }
        for (const update of operation.updates as Array<{ id: string; role: 'assistant'; text: string }>) {
          const index = messages.findIndex((message) => message.id === update.id)
          if (index < 0 || messages[index]!.role !== update.role || typeof messages[index]!.content !== 'string') {
            throw new Error('PROJECTION_OUTPUT_TEXT_APPEND_TARGET_INVALID')
          }
          messages[index] = { ...messages[index]!, content: messages[index]!.content as string + update.text }
        }
        continue
      }
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

/** Stream the current message view without retaining the complete chat body in worker memory. */
export async function* iterateProjectionOutputMessages(
  root: ProjectionBuildOutputManifestRef,
  identity: ProjectionOutputIdentity,
  blobs: ProjectionOutputBlobReader
): AsyncGenerator<ProjectionMaterializedMessage> {
  const chain: ProjectionBuildOutputManifestRef[] = []
  const seen = new Set<string>()
  let current: ProjectionBuildOutputManifestRef | null = root
  while (current) {
    if (seen.has(current.locator)) throw new Error('PROJECTION_OUTPUT_MANIFEST_CYCLE')
    seen.add(current.locator)
    const parsed = await readNode(current)
    chain.push(current)
    const parent = parsed.parent
    if (parent === null) current = null
    else if (!parent || typeof parent !== 'object' || typeof parent.locator !== 'string' ||
      !Number.isSafeInteger(parent.byteLength) || !/^[a-f0-9]{64}$/.test(parent.payloadDigest)) {
      throw new Error('PROJECTION_OUTPUT_MANIFEST_PARENT_INVALID')
    } else current = parent
  }
  chain.reverse()

  let lastReplace: Readonly<{ nodeIndex: number; operationIndex: number }> | undefined
  const firstMessages = new Map<string, Readonly<{ role: unknown; contentIsText: boolean }>>()
  const updates = new Map<string, string[]>()
  for (const [nodeIndex, reference] of chain.entries()) {
    const node = await readNode(reference)
    for (const [operationIndex, candidate] of node.operations.entries()) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('PROJECTION_OUTPUT_OPERATION_INVALID')
      const operation = candidate as { type?: unknown; messages?: unknown; updates?: unknown }
      if (operation.type === 'appendText') {
        if (!Array.isArray(operation.updates) || operation.updates.some((update) => !update || typeof update !== 'object' || Array.isArray(update) ||
          typeof (update as { id?: unknown }).id !== 'string' || !(update as { id: string }).id.trim() ||
          (update as { role?: unknown }).role !== 'assistant' || typeof (update as { text?: unknown }).text !== 'string')) {
          throw new Error('PROJECTION_OUTPUT_OPERATION_INVALID')
        }
        for (const update of operation.updates as Array<{ id: string; role: 'assistant'; text: string }>) {
          const target = firstMessages.get(update.id)
          if (!target || target.role !== update.role || !target.contentIsText) throw new Error('PROJECTION_OUTPUT_TEXT_APPEND_TARGET_INVALID')
          const chunks = updates.get(update.id) ?? []
          chunks.push(update.text)
          updates.set(update.id, chunks)
        }
        continue
      }
      if ((operation.type !== 'append' && operation.type !== 'replace') || !Array.isArray(operation.messages) ||
        operation.messages.some((message) => !isOutputMessage(message))) throw new Error('PROJECTION_OUTPUT_OPERATION_INVALID')
      if (operation.type === 'replace') {
        firstMessages.clear()
        updates.clear()
        lastReplace = { nodeIndex, operationIndex }
      }
      for (const message of operation.messages as ProjectionMaterializedMessage[]) {
        if (typeof message.id === 'string' && !firstMessages.has(message.id)) {
          firstMessages.set(message.id, { role: message.role, contentIsText: typeof message.content === 'string' })
        }
      }
    }
  }

  const emittedIds = new Set<string>()
  for (const [nodeIndex, reference] of chain.entries()) {
    if (lastReplace && nodeIndex < lastReplace.nodeIndex) continue
    const node = await readNode(reference)
    const operationStart = lastReplace && nodeIndex === lastReplace.nodeIndex ? lastReplace.operationIndex : 0
    for (let operationIndex = operationStart; operationIndex < node.operations.length; operationIndex += 1) {
      const candidate = node.operations[operationIndex]
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('PROJECTION_OUTPUT_OPERATION_INVALID')
      const operation = candidate as { type?: unknown; messages?: unknown; updates?: unknown }
      if (operation.type === 'appendText') continue
      if ((operation.type !== 'append' && operation.type !== 'replace') || !Array.isArray(operation.messages) ||
        operation.messages.some((message) => !isOutputMessage(message))) throw new Error('PROJECTION_OUTPUT_OPERATION_INVALID')
      for (const rawMessage of operation.messages as ProjectionMaterializedMessage[]) {
        let message = rawMessage
        if (typeof message.id === 'string' && !emittedIds.has(message.id)) {
          emittedIds.add(message.id)
          const suffix = updates.get(message.id)
          if (suffix?.length) {
            if (message.role !== 'assistant' || typeof message.content !== 'string') throw new Error('PROJECTION_OUTPUT_TEXT_APPEND_TARGET_INVALID')
            message = { ...message, content: message.content + suffix.join('') }
          }
        }
        yield message
      }
    }
  }

  async function readNode(reference: ProjectionBuildOutputManifestRef): Promise<Readonly<{
    parent: ProjectionBuildOutputManifestRef | null; operations: readonly unknown[]
  }>> {
    const payload = await blobs.readVerified(reference)
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
    return { parent: manifest.parent as ProjectionBuildOutputManifestRef | null, operations: manifest.operations }
  }
}

function isOutputMessage(value: unknown): value is ProjectionMaterializedMessage {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as ProjectionMaterializedMessage).role === 'string' && Object.hasOwn(value, 'content')
}
