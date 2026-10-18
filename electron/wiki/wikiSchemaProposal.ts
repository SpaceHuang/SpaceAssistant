import { createHash, randomUUID } from 'node:crypto'
import type { WikiFileStore } from './wikiFileStore'
import { parseWikiSchema } from './wikiSchema'
import { withWikiWriteMutex } from './wikiWriteMutex'
import { parseWikiPageMarker } from './wikiReconciler'

interface SchemaState { formatVersion: 1; schemaVersion: number; contentHash: string }
interface Proposal { formatVersion: 1; proposalId: string; baseVersion: number; baseHash: string; proposedHash: string; content: string; createdAt: number; expiresAt: number }
export class WikiSchemaProposalError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WikiSchemaProposalError' }
}

export function createWikiSchemaProposalService(options: {
  store: WikiFileStore
  now?: () => number
  proposalTtlMs?: number
  verifyConfirmation: (receipt: unknown, proposalId: string) => boolean | Promise<boolean>
}) {
  const now = options.now ?? Date.now
  const ttl = options.proposalTtlMs ?? 30 * 60_000
  return {
    async current() {
      return withWikiWriteMutex(`${options.store.root}/.wiki-domain-lock`, async () => {
        const current = await readCurrent(options.store)
        return { schemaVersion: current.state.schemaVersion, hash: current.hash, content: current.content, categories: parseWikiSchema(current.content).categories, valid: parseWikiSchema(current.content).valid }
      })
    },
    async propose(content: string, expectedSchemaVersion: number) {
      return withWikiWriteMutex(`${options.store.root}/.wiki-domain-lock`, async () => {
        const current = await readCurrent(options.store)
        if (current.state.schemaVersion !== expectedSchemaVersion) throw new WikiSchemaProposalError('schema_conflict')
        if (!parseWikiSchema(content).valid) throw new WikiSchemaProposalError('schema_invalid')
        const proposalId = randomUUID()
        const proposal: Proposal = { formatVersion: 1, proposalId, baseVersion: current.state.schemaVersion, baseHash: current.hash, proposedHash: sha(content), content, createdAt: now(), expiresAt: now() + ttl }
        await options.store.write(`.wiki-service/schema-proposals/${proposalId}.json`, json(proposal))
        const before = new Set(parseWikiSchema(current.content).categories.map(category => category.id))
        const after = new Set(parseWikiSchema(content).categories.map(category => category.id))
        return { proposalId, diff: { before: current.content, after: content }, addedCategoryIds: [...after].filter(id => !before.has(id)), removedCategoryIds: [...before].filter(id => !after.has(id)), expiresAt: proposal.expiresAt }
      })
    },
    async apply(proposalId: string, expectedSchemaVersion: number, receipt: unknown, expectedDiff?: { before: string; after: string }) {
      return withWikiWriteMutex(`${options.store.root}/.wiki-domain-lock`, async () => {
        if (!await options.verifyConfirmation(receipt, proposalId)) throw new WikiSchemaProposalError('confirmation_required')
        const proposal = await readProposal(options.store, proposalId)
        if (proposal.expiresAt <= now()) throw new WikiSchemaProposalError('schema_proposal_expired')
        const current = await readCurrent(options.store)
        if (proposal.baseVersion !== expectedSchemaVersion || current.state.schemaVersion !== expectedSchemaVersion || current.hash !== proposal.baseHash) throw new WikiSchemaProposalError('schema_conflict')
        if (expectedDiff && (expectedDiff.before !== current.content || expectedDiff.after !== proposal.content)) throw new WikiSchemaProposalError('schema_material_mismatch')
        const parsed = parseWikiSchema(proposal.content)
        if (!parsed.valid) throw new WikiSchemaProposalError('schema_invalid')
        const catalog = await options.store.readCatalog()
        const categories = new Map(parsed.categories.map(category => [category.id, category]))
        const conflicts: string[] = []
        for (const page of catalog?.pages ?? []) {
          if (page.categoryId && !categories.has(page.categoryId)) conflicts.push(`${page.pageId}:category`)
          const parent = page.parentPageId ? catalog?.pages.find(item => item.pageId === page.parentPageId) : undefined
          const category = page.categoryId ? categories.get(page.categoryId) : undefined
          if (parent && category?.allowedParentCategoryIds && !category.allowedParentCategoryIds.includes(parent.categoryId ?? '')) conflicts.push(`${page.pageId}:parent-category`)
        }
        if (conflicts.length) throw Object.assign(new WikiSchemaProposalError('schema_conflict'), { conflicts })
        const identity = await options.store.identity('SCHEMA.md')
        if (!identity) throw new WikiSchemaProposalError('schema_conflict')
        await writeSchemaSnapshot(options.store, current.state.schemaVersion, current.content)
        await options.store.write('SCHEMA.md', proposal.content, identity)
        const schemaVersion = current.state.schemaVersion + 1
        const hash = sha(proposal.content)
        await options.store.writeImmutable(`.wiki-service/schema-history/${schemaVersion}.md`, Buffer.from(proposal.content))
        await options.store.write('.wiki-service/schema-state.json', json({ formatVersion: 1, schemaVersion, contentHash: hash } satisfies SchemaState))
        return { schemaVersion, hash }
      })
    },
  }
}

async function readCurrent(store: WikiFileStore): Promise<{ content: string; hash: string; state: SchemaState }> {
  const content = await store.readText('SCHEMA.md')
  const hash = sha(content)
  const state = await readState(store) ?? { formatVersion: 1 as const, schemaVersion: 1, contentHash: hash }
  if (state.contentHash !== hash) {
    const updated = { ...state, schemaVersion: state.schemaVersion + 1, contentHash: hash }
    await store.write('.wiki-service/schema-state.json', json(updated))
    return { content, hash, state: updated }
  }
  return { content, hash, state }
}
async function readState(store: WikiFileStore): Promise<SchemaState | undefined> {
  try { return JSON.parse(await store.readText('.wiki-service/schema-state.json')) as SchemaState }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function readProposal(store: WikiFileStore, proposalId: string): Promise<Proposal> {
  if (!/^[0-9a-f-]{36}$/i.test(proposalId)) throw new WikiSchemaProposalError('schema_proposal_missing')
  try { return JSON.parse(await store.readText(`.wiki-service/schema-proposals/${proposalId}.json`)) as Proposal }
  catch { throw new WikiSchemaProposalError('schema_proposal_missing') }
}
function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
async function writeSchemaSnapshot(store: WikiFileStore, version: number, content: string): Promise<void> {
  const relativePath = `.wiki-service/schema-history/${version}.md`
  try {
    const existing = await store.readText(relativePath)
    if (sha(existing) !== sha(content)) throw new WikiSchemaProposalError('schema_conflict')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await store.writeImmutable(relativePath, Buffer.from(content))
  }
}
