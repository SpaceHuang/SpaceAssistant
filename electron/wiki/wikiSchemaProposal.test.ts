import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiSchemaProposalService } from './wikiSchemaProposal'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const schema = (name = 'Topic') => `# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"${name}","description":"A topic","status":"active"}]}\n<!-- wiki-categories:end -->\n`
async function fixture(verifyConfirmation: (receipt: unknown, proposalId: string) => boolean | Promise<boolean> = receipt => receipt === 'approved') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-schema-proposal-'))
  roots.push(root)
  const store = createWikiFileStore(root)
  await store.write('SCHEMA.md', schema())
  return { root, store, service: createWikiSchemaProposalService({ store, verifyConfirmation }) }
}

describe('WikiSchemaProposalService', () => {
  it('keeps proposals separate from the active SCHEMA and requires a host confirmation receipt', async () => {
    const { root, service } = await fixture()
    const proposal = await service.propose(schema('Knowledge'), 1)
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toBe(schema())
    await expect(service.apply(proposal.proposalId, 1, 'model-says-approved')).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toBe(schema())
    await expect(service.apply(proposal.proposalId, 1, 'approved')).rejects.toMatchObject({ code: 'schema_material_mismatch' })
    await expect(service.apply(proposal.proposalId, 1, 'approved', proposal.diff)).resolves.toMatchObject({ schemaVersion: 2 })
    expect(await readFile(path.join(root, '.wiki-service/schema-history/1.md'), 'utf8')).toBe(schema())
  })

  it('persists and replays the exact confirmed schema apply invocation', async () => {
    const { root, service } = await fixture(receipt => !!receipt && typeof receipt === 'object' && (receipt as { confirmed?: unknown }).confirmed === true)
    const proposal = await service.propose(schema('Knowledge'), 1)
    const receipt = { confirmed: true, requestId: 'request-apply', toolUseId: 'tool-apply', sessionId: 'session-a', lane: 'desktop' }
    const first = await service.apply(proposal.proposalId, 1, receipt, proposal.diff)
    await expect(service.apply(proposal.proposalId, 1, receipt, proposal.diff)).resolves.toEqual(first)
    await expect(service.apply(proposal.proposalId, 1, { ...receipt, toolUseId: 'different-tool' }, proposal.diff)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const saved = JSON.parse(await readFile(path.join(root, '.wiki-service/schema-proposals', `${proposal.proposalId}.json`), 'utf8'))
    expect(saved.applied).toMatchObject({ invocation: { requestId: 'request-apply', toolUseId: 'tool-apply' }, result: first })
  })

  it('recovers an interrupted apply from its persisted journal after SCHEMA was written', async () => {
    const { root, store, service } = await fixture(receipt => !!receipt && typeof receipt === 'object' && (receipt as { confirmed?: unknown }).confirmed === true)
    const proposedContent = schema('Knowledge')
    const proposal = await service.propose(proposedContent, 1)
    const savedProposal = JSON.parse(await readFile(path.join(root, '.wiki-service/schema-proposals', `${proposal.proposalId}.json`), 'utf8')) as { baseVersion: number; baseHash: string; proposedHash: string }
    const receipt = { confirmed: true, requestId: 'request-crash', toolUseId: 'tool-crash', sessionId: 'session-a', lane: 'desktop' }
    const invocation = { requestId: receipt.requestId, toolUseId: receipt.toolUseId, sessionId: receipt.sessionId, lane: receipt.lane }
    const result = { schemaVersion: 2, hash: savedProposal.proposedHash }
    await store.write('SCHEMA.md', proposedContent)
    await store.write(`.wiki-service/schema-applications/${proposal.proposalId}.json`, JSON.stringify({ formatVersion: 1, proposalId: proposal.proposalId, status: 'prepared',
      baseVersion: savedProposal.baseVersion, baseHash: savedProposal.baseHash, baseContent: schema(), proposedHash: savedProposal.proposedHash, invocation,
      invocationHash: createHash('sha256').update(JSON.stringify({ lane: invocation.lane, requestId: invocation.requestId, sessionId: invocation.sessionId, toolUseId: invocation.toolUseId })).digest('hex'), result }))

    await expect(service.apply(proposal.proposalId, 1, receipt, proposal.diff)).resolves.toEqual(result)
    expect(JSON.parse(await readFile(path.join(root, '.wiki-service/schema-applications', `${proposal.proposalId}.json`), 'utf8'))).toMatchObject({ status: 'completed', result })
    expect(JSON.parse(await readFile(path.join(root, '.wiki-service/schema-state.json'), 'utf8'))).toMatchObject({ schemaVersion: 2, contentHash: savedProposal.proposedHash })
  })

  it('retries an apply when the schema snapshot was written before the state update failed', async () => {
    const { root, store } = await fixture(receipt => !!receipt && typeof receipt === 'object' && (receipt as { confirmed?: unknown }).confirmed === true)
    const verifyConfirmation = (receipt: unknown) => !!receipt && typeof receipt === 'object' && (receipt as { confirmed?: unknown }).confirmed === true
    const service = createWikiSchemaProposalService({ store, verifyConfirmation })
    const proposedContent = schema('Knowledge')
    const proposal = await service.propose(proposedContent, 1)
    const receipt = { confirmed: true, requestId: 'request-retry', toolUseId: 'tool-retry', sessionId: 'session-a', lane: 'desktop' }
    const originalWrite = store.write.bind(store)
    let failed = false
    store.write = async (relativePath, content, expectedIdentity) => {
      if (!failed && relativePath === '.wiki-service/schema-state.json') {
        failed = true
        throw new Error('simulated state write failure')
      }
      return originalWrite(relativePath, content, expectedIdentity)
    }
    await expect(service.apply(proposal.proposalId, 1, receipt, proposal.diff)).rejects.toThrow('simulated state write failure')
    store.write = originalWrite
    expect(await readFile(path.join(root, '.wiki-service/schema-history/2.md'), 'utf8')).toBe(proposedContent)

    const retryService = createWikiSchemaProposalService({ store, verifyConfirmation })
    await expect(retryService.apply(proposal.proposalId, 1, receipt, proposal.diff)).resolves.toMatchObject({ schemaVersion: 2 })
  })

  it('rejects stale proposals without changing schema bytes', async () => {
    const { root, store, service } = await fixture()
    const proposal = await service.propose(schema('Proposed'), 1)
    await store.write('SCHEMA.md', schema('External'))
    await expect(service.apply(proposal.proposalId, 1, 'approved', proposal.diff)).rejects.toMatchObject({ code: 'schema_conflict' })
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toBe(schema('External'))
  })

  it('requires the exact before and after material shown in the confirmation invocation', async () => {
    const { root, service } = await fixture()
    const proposed = schema('Knowledge')
    const proposal = await service.propose(proposed, 1)
    const diff = { before: schema(), after: proposed }
    await expect(service.apply(proposal.proposalId, 1, 'approved', { ...diff, after: schema('Tampered') })).rejects.toMatchObject({ code: 'schema_material_mismatch' })
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toBe(schema())
    await expect(service.apply(proposal.proposalId, 1, 'approved', diff)).resolves.toMatchObject({ schemaVersion: 2 })
  })

  it('rejects invalid proposals before persisting them', async () => {
    const { root, service } = await fixture()
    await expect(service.propose('# Invalid', 1)).rejects.toMatchObject({ code: 'schema_invalid' })
    await expect(import('node:fs/promises').then(fs => fs.readdir(path.join(root, '.wiki-service/schema-proposals')))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
