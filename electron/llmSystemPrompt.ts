import { app } from 'electron'
import { appendUiLocaleSystemHint } from '../src/shared/llmLocalePrompt'
import { detectLocaleFromSystem, isAppLocale, type AppLocale } from '../src/shared/locale'
import { readAppLocale } from './appIpc'
import type { AppDatabase } from './database'
import { buildSystemPrompt } from './projectMemory'

export function resolveRequestLocale(payloadLocale: unknown, db?: AppDatabase): AppLocale {
  if (typeof payloadLocale === 'string' && isAppLocale(payloadLocale)) return payloadLocale
  if (db) return readAppLocale(db)
  return detectLocaleFromSystem(app.getLocale())
}

export function buildFinalSystemPrompt(args: {
  system?: string
  memoryContent: string | null
  memoryEnabled: boolean
  locale: AppLocale
}): string | undefined {
  const withMemory = buildSystemPrompt(args.system, args.memoryContent, args.memoryEnabled)
  return appendUiLocaleSystemHint(withMemory, args.locale)
}
