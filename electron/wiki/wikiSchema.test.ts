import { describe, expect, it } from 'vitest'

import { parseWikiSchema } from './wikiSchema'

const validSchema = `# Wiki rules\n\nUse these categories.\n\n<!-- wiki-categories:start -->\n{\n  "formatVersion": 1,\n  "categories": [\n    { "id": "topic", "name": "主题", "description": "主题页面", "status": "active" },\n    { "id": "concept", "name": "概念", "description": "术语", "status": "active", "allowedParentCategoryIds": ["topic"] }\n  ]\n}\n<!-- wiki-categories:end -->\n`

describe('parseWikiSchema', () => {
  it('parses one structured block and leaves surrounding rules intact', () => {
    const result = parseWikiSchema(validSchema)

    expect(result).toMatchObject({
      valid: true,
      rules: '# Wiki rules\n\nUse these categories.',
      categories: [
        { id: 'topic', name: '主题', description: '主题页面', status: 'active' },
        { id: 'concept', allowedParentCategoryIds: ['topic'] },
      ],
    })
  })

  it.each([
    ['missing block', '# Rules only'],
    ['duplicate blocks', `${validSchema}\n${validSchema}`],
    ['unclosed block', '<!-- wiki-categories:start -->\n{}'],
    ['unsupported format version', validSchema.replace('"formatVersion": 1', '"formatVersion": 2')],
    ['duplicate category id', validSchema.replace('"id": "concept"', '"id": "topic"')],
    ['unknown parent category', validSchema.replace('"topic"]', '"missing"]')],
    ['invalid status', validSchema.replace('"status": "active"', '"status": "hidden"')],
    ['duplicate JSON key', validSchema.replace('"name": "主题",', '"name": "主题", "name": "重复",')],
  ])('returns a diagnostic for %s', (_case, input) => {
    const result = parseWikiSchema(input)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics[0]).toMatchObject({ code: expect.any(String), line: expect.any(Number) })
  })
})
