const SCHEMA_SECTION = '## Wiki Schema（项目规范）'

export function appendWikiSchemaToSystemPrompt(base: string | undefined, schemaContent: string | null): string | undefined {
  if (!schemaContent?.trim()) return base
  const block = `${SCHEMA_SECTION}\n\n${schemaContent.trim()}`
  if (base?.trim()) return `${base.trim()}\n\n${block}`
  return block
}
