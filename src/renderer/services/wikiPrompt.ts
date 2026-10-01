import { runtimeText } from '../i18n/runtimeText'

export function appendWikiSchemaToSystemPrompt(base: string | undefined, schemaContent: string | null): string | undefined {
  if (!schemaContent?.trim()) return base
  const block = `${runtimeText('wiki.schemaSection')}\n\n${schemaContent.trim()}`
  if (base?.trim()) return `${base.trim()}\n\n${block}`
  return block
}
