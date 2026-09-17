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
      '## Capability toolkit',
      'The product exposes a capability toolkit: when you need runtime facts (product/OS/dev environment/work dir/current time/browser dependencies) or product actions (MCP management, session status/list/messages), first call `toolkit.find` with a purpose description to learn the usage, then call `toolkit.call` with the returned capability id. If no capability fits, say so honestly instead of inventing one.'
    ].join('\n')
  }
  return [
    '## 工具调用约定',
    '文件类工具（read_file / edit_file / write_file / list_directory / grep）的路径参数字段名为 `path`，请勿使用 `filePath` 或 `file_path`。',
    '## 能力集合（toolkit）',
    '产品提供能力集合：需要了解运行环境（产品/系统/开发环境/工作目录/时间/浏览器依赖）或执行产品功能（MCP 管理、会话状态/列表/消息）时，先用 toolkit.find 按用途描述查询用法，再用 toolkit.call 以返回的能力 id 调用。能力不足时如实报告，不要编造。'
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
}): string | undefined {
  const sections: PromptSection[] = [
    buildBaseSystemSection(args),
    buildToolConventionSection(args.locale),
    ...(args.hasImageAttachments ? [buildImageAttachmentsSection(args.locale)] : []),
    buildUiLocaleSection(args.locale),
    ...(args.skillCatalog?.length ? [buildSkillCatalogSection(args.skillCatalog, args.contextWindow ?? 200_000)] : [])
  ]
  return renderPrompt(buildPromptAssembly({ sections })) || undefined
}
