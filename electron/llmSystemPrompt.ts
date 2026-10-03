import { app } from 'electron'
import { appendUiLocaleSystemHint } from '../src/shared/llmLocalePrompt'
import { detectLocaleFromSystem, isAppLocale, type AppLocale } from '../src/shared/locale'
import { readAppLocale } from './appIpc'
import type { AppDatabase } from './database'
import { buildSystemPrompt } from './projectMemory'
import { buildPromptAssembly, renderPrompt, type PromptSection } from '../src/shared/promptAssembly'
import { buildSkillCatalogSection } from '../src/shared/skillPrompt'
import type { SkillDefinition } from '../src/shared/domainTypes'

export function resolveRequestLocale(payloadLocale: unknown, db?: AppDatabase): AppLocale {
  if (typeof payloadLocale === 'string' && isAppLocale(payloadLocale)) return payloadLocale
  if (db) return readAppLocale(db)
  return detectLocaleFromSystem(app.getLocale())
}

export function buildImageAttachmentsSystemHint(locale: AppLocale): string {
  if (locale === 'en-US') {
    return [
      '## Image attachments',
      'The user message includes image(s). Answer based on the image content directly.',
      'Do not use run_script / OCR scripts to read images; do not use read_file on binary image files.',
      'If the image cannot be recognized, say so explicitly rather than guessing.'
    ].join('\n')
  }
  return [
    '## 图片附件',
    '用户消息已附带图片，请直接根据图片内容回答。',
    '不要为读取图片编写 run_script / OCR 脚本；不要使用 read_file 读取二进制图片文件。',
    '若图片无法识别，请明确说明无法查看图片，而不是猜测。'
  ].join('\n')
}

export function buildToolConventionHint(locale: AppLocale): string {
  if (locale === 'en-US') {
    return [
      '## Tool call conventions',
      'For file tools (read_file / edit_file / write_file / list_directory / grep), the path argument is named `path`. Do not use `filePath` or `file_path`.',
      'Every tool call you issue is your own action, including sibling calls issued together. Never describe your own writes as another agent or person’s writes. Claim that another writer changed a file only when tool output or correlated execution records explicitly establish a distinct writer; a stale-edit rejection or changed file alone does not identify who changed it.',
      'When editing several documents whose meaning or cross-references depend on each other, edit them in sequence: read the current file immediately before editing it, avoid overlapping edits to the same file, then reread the affected documents and check consistency before claiming another writer caused a conflict.'
    ].join('\n')
  }
  return [
    '## 工具调用约定',
    '文件类工具（read_file / edit_file / write_file / list_directory / grep）的路径参数字段名为 `path`，请勿使用 `filePath` 或 `file_path`。',
    '你发出的每个工具调用都属于你自己的操作，包括同一批一起发出的调用。不得把自己的写入描述成其他 Agent 或其他人的写入。只有工具结果或可关联的执行记录明确证明写入者不同，才能断言有其他写入者；旧内容保护拒绝编辑或文件内容发生变化，本身不能证明是谁改的。',
    '修改多篇语义或交叉引用互相依赖的文档时，按顺序逐篇处理：每次编辑前重新读取当前文件，不要对同一文件发起重叠编辑；完成后复读受影响文档并检查一致性，再判断是否存在其他写入者造成的冲突。'
  ].join('\n')
}

export function buildBaseSystemSection(args: {
  system?: string
  memoryContent: string | null
  memoryEnabled: boolean
}): PromptSection {
  return {
    name: 'system:base',
    order: 10,
    text: buildSystemPrompt(args.system, args.memoryContent, args.memoryEnabled) ?? ''
  }
}

export function buildToolConventionSection(locale: AppLocale): PromptSection {
  return { name: 'system:tool-conventions', order: 20, text: buildToolConventionHint(locale) }
}

export function buildImageAttachmentsSection(locale: AppLocale): PromptSection {
  return { name: 'system:image-attachments', order: 30, text: buildImageAttachmentsSystemHint(locale) }
}

export function buildUiLocaleSection(locale: AppLocale): PromptSection {
  return { name: 'system:ui-locale', order: 40, text: appendUiLocaleSystemHint(undefined, locale) ?? '' }
}

export function buildFinalSystemPrompt(args: {
  system?: string
  memoryContent: string | null
  memoryEnabled: boolean
  locale: AppLocale
  hasImageAttachments?: boolean
  skillCatalog?: SkillDefinition[]
  contextWindow?: number
  /** FR1：MCP 工具索引区块（延迟模式生成；无延迟工具时缺省，不产生空区块）。 */
  mcpCatalog?: PromptSection
}): string | undefined {
  const sections: PromptSection[] = [
    buildBaseSystemSection(args),
    buildToolConventionSection(args.locale),
    ...(args.hasImageAttachments ? [buildImageAttachmentsSection(args.locale)] : []),
    buildUiLocaleSection(args.locale),
    // order 45：位于工具约定 hint（order 20/40）与 ## Skills（order 50）之间（§6.2）
    ...(args.mcpCatalog ? [args.mcpCatalog] : []),
    ...(args.skillCatalog?.length ? [buildSkillCatalogSection(args.skillCatalog, args.contextWindow ?? 200_000)] : [])
  ]
  return renderPrompt(buildPromptAssembly({ sections })) || undefined
}
