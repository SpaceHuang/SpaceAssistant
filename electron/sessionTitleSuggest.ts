import type { WebContents } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { createAnthropicClient } from './anthropicClientFactory'
import { readAppLocale } from './appIpc'
import { normalizeToolLoopMaxTokens } from '../src/shared/llm/toolLoopMaxTokens'
import { buildClaudeToolChatMessages } from '../src/shared/claudeToolHistory'
import type { Message, Session } from '../src/shared/domainTypes'
import type { AppLocale } from '../src/shared/locale'
import { updateSession, getSession, getMessages, type AppDatabase } from './database'

export const SESSION_META_TITLE_GENERATED = 'titleGenerated'
export const SESSION_META_TITLE_USER_CUSTOM = 'titleUserCustom'
/** 老会话「打开补标题」已尝试过（成功或放弃），避免反复调度 */
export const SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED = 'titleOpenBackfillAttempted'

/** 会话维度：累计第几条 API assistant 消息（历史 + 本次循环）后尝试生成标题 */
export const TITLE_SUGGEST_TRIGGER_AT_ASSISTANT_TURN = 3

const TITLE_SUGGEST_MAX_ASSISTANT_TURNS = TITLE_SUGGEST_TRIGGER_AT_ASSISTANT_TURN
const TITLE_SUGGEST_LLM_TIMEOUT_MS = 45_000
const TITLE_MAX_CHARS = 15

const TITLE_SYSTEM_PROMPT_ZH = `你是一个对话主题提炼助手。请根据以下对话内容，用不超过15个汉字概括本次对话的核心主题。
只输出主题文字，不要加任何标点、序号或解释。`

const TITLE_SYSTEM_PROMPT_EN =
  'Summarize the conversation topic in at most 15 Unicode characters, in English. Output only the title text, no punctuation or explanation.'

const inFlightSessionIds = new Set<string>()

export function getTitleSystemPrompt(locale: AppLocale): string {
  return locale === 'en-US' ? TITLE_SYSTEM_PROMPT_EN : TITLE_SYSTEM_PROMPT_ZH
}

export function formatTitleDialogueLabel(role: 'user' | 'assistant', locale: AppLocale): string {
  if (locale === 'en-US') {
    return role === 'user' ? 'User: ' : 'Assistant: '
  }
  return role === 'user' ? '用户：' : '助手：'
}

function extractTextFromMessageContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: string }).type
    if (type === 'text' && typeof (block as { text?: string }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n').trim()
}

/** 仅 user/assistant 的可见文本，跳过 tool 块；从头累计直到包含前 N 条 assistant 文本 */
export function buildTitleSuggestDialogueText(
  messages: Anthropic.MessageParam[],
  maxAssistantTurns: number,
  locale: AppLocale = 'zh-CN'
): string {
  let assistantSeen = 0
  const lines: string[] = []
  outer: for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    const text = extractTextFromMessageContent(msg.content)
    const label = formatTitleDialogueLabel(msg.role, locale)
    if (text.length > 0) {
      lines.push(`${label}${text}`)
    }
    if (msg.role === 'assistant') {
      assistantSeen += 1
      if (assistantSeen >= maxAssistantTurns) break outer
    }
  }
  return lines.join('\n')
}

/**
 * 口径 B：历史 API `assistant` 条数 + 本次 `loopRound` 是否已达「至少第 N 条」（N 见 `TITLE_SUGGEST_TRIGGER_AT_ASSISTANT_TURN`）。
 * 单次 invoke 内应配合「至多调度一次」标志，避免工具多轮时重复调用摘要接口。
 */
export function reachedCumulativeAssistantTurnsForTitleSuggest(
  historicalAssistantApiMessageCount: number,
  loopRound: number
): boolean {
  return historicalAssistantApiMessageCount + loopRound >= TITLE_SUGGEST_TRIGGER_AT_ASSISTANT_TURN
}

/** 与 `buildClaudeToolChatMessages` 对齐：每条已完成 assistant 气泡计 1 */
export function countCompletedAssistantMessagesForTitleSuggest(messages: Message[]): number {
  return messages.filter((m) => m.role === 'assistant' && m.status !== 'streaming').length
}

function normalizeSuggestedTitle(raw: string): string {
  let s = raw.replace(/\s+/g, '').trim()
  s = s.replace(/^[0-9一二三四五六七八九十]+[\.、:：]\s*/, '')
  s = s.replace(/[。！？，、；：""''（）【】《》…—-]+$/g, '')
  const chars = Array.from(s)
  return chars.slice(0, TITLE_MAX_CHARS).join('')
}

export function scheduleSessionTitleSuggestion(args: {
  db: AppDatabase
  sender: WebContents
  sessionId: string
  model: string
  baseUrl?: string
  messagesForApi: Anthropic.MessageParam[]
  getApiKey: () => Promise<string | null>
}): void {
  const { db, sender, sessionId, model, baseUrl, messagesForApi, getApiKey } = args
  const locale = readAppLocale(db)

  const cur = db.data.sessions.find((s) => s.id === sessionId)
  if (!cur) return
  if (cur.metadata?.[SESSION_META_TITLE_GENERATED] === true) return
  if (cur.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return
  if (inFlightSessionIds.has(sessionId)) return

  const dialogue = buildTitleSuggestDialogueText(messagesForApi, TITLE_SUGGEST_MAX_ASSISTANT_TURNS, locale)
  if (!dialogue.trim()) return

  inFlightSessionIds.add(sessionId)

  void (async () => {
    try {
      const apiKey = await getApiKey()
      if (!apiKey) return

      const fresh = db.data.sessions.find((s) => s.id === sessionId)
      if (!fresh) return
      if (fresh.metadata?.[SESSION_META_TITLE_GENERATED] === true) return
      if (fresh.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return

      const client = createAnthropicClient(apiKey, baseUrl)
      const userContent =
        locale === 'en-US' ? `Conversation:\n${dialogue}` : `对话内容：\n${dialogue}`

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TITLE_SUGGEST_LLM_TIMEOUT_MS)
      let title = ''
      try {
        const res = (await client.messages.create(
          {
            model,
            max_tokens: normalizeToolLoopMaxTokens(128),
            temperature: 0,
            system: getTitleSystemPrompt(locale),
            messages: [{ role: 'user', content: userContent }],
            stream: false
          },
          { signal: controller.signal }
        )) as { content?: unknown[] }
        const blocks = Array.isArray(res?.content) ? res.content : []
        const textBlock = blocks.find((b: unknown) => b && typeof b === 'object' && (b as { type?: string }).type === 'text') as
          | { type: 'text'; text: string }
          | undefined
        title = normalizeSuggestedTitle(typeof textBlock?.text === 'string' ? textBlock.text : '')
      } finally {
        clearTimeout(timer)
      }

      if (!title) return

      const again = db.data.sessions.find((s) => s.id === sessionId)
      if (!again) return
      if (again.metadata?.[SESSION_META_TITLE_GENERATED] === true) return
      if (again.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return

      const updated = updateSession(db, sessionId, {
        name: title,
        metadata: { ...again.metadata, [SESSION_META_TITLE_GENERATED]: true }
      })
      if (updated) {
        sender.send('session:title-generated', { session: updated })
      }
    } catch {
      // 静默忽略
    } finally {
      inFlightSessionIds.delete(sessionId)
    }
  })()
}

/**
 * 老会话首次打开：若从未自动生成标题、未标用户自定义、已有足够 assistant，
 * 则从 DB 拉消息并异步摘要一次；写入 `titleOpenBackfillAttempted` 防止重复。
 * @returns 若写入了 metadata（含仅标记 attempted），返回更新后的 Session 供渲染进程合并
 */
export function scheduleSessionTitleOpenBackfillIfNeeded(args: {
  db: AppDatabase
  sender: WebContents
  sessionId: string
  baseUrl?: string
  getApiKey: () => Promise<string | null>
}): Session | undefined {
  const { db, sender, sessionId, baseUrl, getApiKey } = args
  const locale = readAppLocale(db)

  const session = getSession(db, sessionId)
  if (!session) return undefined
  if (session.metadata?.[SESSION_META_TITLE_GENERATED] === true) return undefined
  if (session.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return undefined
  if (session.metadata?.[SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED] === true) return undefined
  if (inFlightSessionIds.has(sessionId)) return undefined

  const rowMessages = getMessages(db, sessionId, 10_000, 0)
  if (countCompletedAssistantMessagesForTitleSuggest(rowMessages) < TITLE_SUGGEST_TRIGGER_AT_ASSISTANT_TURN) {
    return undefined
  }

  const convo = buildClaudeToolChatMessages(rowMessages)
  const messagesForApi: Anthropic.MessageParam[] = convo.map((m) => ({
    role: m.role as Anthropic.MessageParam['role'],
    content: m.content as Anthropic.MessageParam['content']
  }))

  const dialogue = buildTitleSuggestDialogueText(messagesForApi, TITLE_SUGGEST_MAX_ASSISTANT_TURNS, locale)
  const metaNext: Record<string, unknown> = { ...session.metadata, [SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED]: true }
  if (!dialogue.trim()) {
    return updateSession(db, sessionId, { metadata: metaNext })
  }

  const marked = updateSession(db, sessionId, { metadata: metaNext })
  if (!marked) return undefined

  scheduleSessionTitleSuggestion({
    db,
    sender,
    sessionId,
    model: session.model,
    baseUrl,
    messagesForApi,
    getApiKey
  })

  return getSession(db, sessionId)
}
