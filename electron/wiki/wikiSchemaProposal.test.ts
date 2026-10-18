import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    await expect(service.apply(proposal.proposalId, 1, 'approved')).resolves.toMatchObject({ schemaVersion: 2 })
    expect(await readFile(path.join(root, '.wiki-service/schema-history/1.md'), 'utf8')).toBe(schema())
  })

  it('rejects stale proposals without changing schema bytes', async () => {
    const { root, store, service } = await fixture()
    const proposal = await service.propose(schema('Proposed'), 1)
    await store.write('SCHEMA.md', schema('External'))
    await expect(service.apply(proposal.proposalId, 1, 'approved')).rejects.toMatchObject({ code: 'schema_conflict' })
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toBe(schema('External'))
  })

  it('rejects invalid proposals before persisting them', async () => {
    const { root, service } = await fixture()
    await expect(service.propose('# Invalid', 1)).rejects.toMatchObject({ code: 'schema_invalid' })
    await expect(import('node:fs/promises').then(fs => fs.readdir(path.join(root, '.wiki-service/schema-proposals')))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
