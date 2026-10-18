import type { WikiCategory, WikiSchemaDiagnostic, WikiSchemaParseResult } from '../../src/shared/wikiDomainTypes'

const START = '<!-- wiki-categories:start -->'
const END = '<!-- wiki-categories:end -->'

interface JsonValue { [key: string]: unknown }

function findDuplicateKeys(source: string): string[] {
  const duplicates = new Set<string>()
  const stack: Array<{ keys: Set<string>; expectKey: boolean }> = []
  let inString = false
  let escaped = false
  let token = ''

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') {
        inString = false
        let next = i + 1
        while (/\s/.test(source[next] ?? '')) next += 1
        if (source[next] === ':' && stack.length > 0) {
          const frame = stack[stack.length - 1]
          if (frame.keys.has(token)) duplicates.add(token)
          frame.keys.add(token)
          frame.expectKey = false
        }
        token = ''
      } else token += char
      continue
    }
    if (char === '"') { inString = true; token = ''; continue }
    if (char === '{') stack.push({ keys: new Set(), expectKey: true })
    else if (char === '}') stack.pop()
    else if (char === ',') { const frame = stack[stack.length - 1]; if (frame) frame.expectKey = true }
  }
  return [...duplicates]
}

function diagnostic(code: string, message: string, line: number, categoryId?: string): WikiSchemaDiagnostic {
  return { code, message, line, ...(categoryId ? { categoryId } : {}) }
}

export function parseWikiSchema(source: string): WikiSchemaParseResult {
  const lines = source.split(/\r?\n/)
  const starts: number[] = []
  const ends: number[] = []
  lines.forEach((line, index) => {
    if (line.trim() === START) starts.push(index)
    if (line.trim() === END) ends.push(index)
  })
  const rules = starts.length === 1 && ends.length === 1 && starts[0] < ends[0]
    ? [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)].join('\n').trimEnd()
    : source
  const errors: WikiSchemaDiagnostic[] = []

  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    const code = starts.length === 0 && ends.length === 0 ? 'wiki-schema-block-missing' : 'wiki-schema-block-invalid'
    errors.push(diagnostic(code, 'SCHEMA must contain exactly one closed wiki-categories block.', Math.max(1, (starts[0] ?? ends[0] ?? 0) + 1)))
    return { valid: false, categories: [], rules, diagnostics: errors }
  }

  const jsonLines = lines.slice(starts[0] + 1, ends[0])
  const json = jsonLines.join('\n')
  for (const key of findDuplicateKeys(json)) errors.push(diagnostic('wiki-schema-json-duplicate-key', `Duplicate JSON key: ${key}`, starts[0] + 2))
  let value: JsonValue | undefined
  try { value = JSON.parse(json) as JsonValue } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON.'
    errors.push(diagnostic('wiki-schema-json-invalid', message, starts[0] + 2))
  }
  if (!value) return { valid: false, categories: [], rules, diagnostics: errors }

  if (value.formatVersion !== 1) errors.push(diagnostic('wiki-schema-format-unsupported', 'formatVersion must be 1.', starts[0] + 2))
  if (!Array.isArray(value.categories)) errors.push(diagnostic('wiki-schema-categories-invalid', 'categories must be an array.', starts[0] + 2))
  const categories: WikiCategory[] = []
  const seenIds = new Set<string>()
  for (const raw of Array.isArray(value.categories) ? value.categories : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(diagnostic('wiki-schema-category-invalid', 'Each category must be an object.', starts[0] + 2)); continue
    }
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : undefined
    const categoryLine = starts[0] + 2 + Math.max(0, jsonLines.findIndex(line => id && line.includes(`"${id}"`)))
    if (!id || !/^[a-z][a-z0-9_-]*$/.test(id)) errors.push(diagnostic('wiki-schema-category-id-invalid', 'Category id must be a stable lowercase ASCII identifier.', categoryLine, id))
    else if (seenIds.has(id)) errors.push(diagnostic('wiki-schema-category-id-duplicate', 'Category id must be unique.', categoryLine, id))
    else seenIds.add(id)
    if (typeof item.name !== 'string' || !item.name.trim()) errors.push(diagnostic('wiki-schema-category-name-invalid', 'Category name is required.', categoryLine, id))
    if (typeof item.description !== 'string' || !item.description.trim()) errors.push(diagnostic('wiki-schema-category-description-invalid', 'Category description is required.', categoryLine, id))
    if (item.status !== 'active' && item.status !== 'deprecated') errors.push(diagnostic('wiki-schema-category-status-invalid', 'Category status must be active or deprecated.', categoryLine, id))
    if (item.allowedParentCategoryIds !== undefined && (!Array.isArray(item.allowedParentCategoryIds) || item.allowedParentCategoryIds.some(parent => typeof parent !== 'string'))) {
      errors.push(diagnostic('wiki-schema-parent-ids-invalid', 'allowedParentCategoryIds must be an array of category ids.', categoryLine, id))
    }
    if (id && /^[a-z][a-z0-9_-]*$/.test(id) && typeof item.name === 'string' && typeof item.description === 'string' && (item.status === 'active' || item.status === 'deprecated') && (item.allowedParentCategoryIds === undefined || Array.isArray(item.allowedParentCategoryIds))) {
      categories.push({ id, name: item.name, description: item.description, status: item.status, ...(item.allowedParentCategoryIds ? { allowedParentCategoryIds: item.allowedParentCategoryIds as string[] } : {}) })
    }
  }
  for (const category of categories) for (const parentId of category.allowedParentCategoryIds ?? []) {
    if (!seenIds.has(parentId)) errors.push(diagnostic('wiki-schema-parent-unknown', `Unknown parent category: ${parentId}`, starts[0] + 2, category.id))
  }

  return errors.length
    ? { valid: false, categories: [], rules, diagnostics: errors }
    : { valid: true, formatVersion: 1, categories, rules, diagnostics: [] }
}
