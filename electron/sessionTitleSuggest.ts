import Anthropic from '@anthropic-ai/sdk'
import { createAnthropicClient } from './anthropicClientFactory'
import { readAppLocale } from './appIpc'
import { normalizeToolLoopMaxTokens } from '../src/shared/llm/toolLoopMaxTokens'
import { buildClaudeToolChatMessages } from '../src/shared/claudeToolHistory'
import type { Message, Session } from '../src/shared/domainTypes'
import type { AppLocale } from '../src/shared/locale'
import { SESSION_TITLE_MAX_LENGTH } from '../src/shared/sessionDisplay'
import { updateSession, getSession, getMessages, type AppDatabase } from './database'
import { logHistoryOversizedToolResult } from './oversizedToolResultLog'

export const SESSION_META_TITLE_GENERATED = 'titleGenerated'
export const SESSION_META_TITLE_USER_CUSTOM = 'titleUserCustom'
/** 老会话「打开补标题」成功完成；失败时移除以便后续重试。 */
export const SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED = 'titleOpenBackfillAttempted'

/** user + assistant 可见消息累计达到该数量后尝试生成标题。 */
export const TITLE_SUGGEST_TRIGGER_AT_MESSAGE_COUNT = 3

const TITLE_SUGGEST_MAX_MESSAGES = TITLE_SUGGEST_TRIGGER_AT_MESSAGE_COUNT
const TITLE_SUGGEST_LLM_TIMEOUT_MS = 45_000
const TITLE_MAX_CHARS = SESSION_TITLE_MAX_LENGTH

const TITLE_SYSTEM_PROMPT_ZH = `你是一个对话主题提炼助手。请根据以下对话内容，用不超过${TITLE_MAX_CHARS}个汉字概括本次对话的核心主题。
只输出主题文字，不要加任何标点、序号或解释。`

const TITLE_SYSTEM_PROMPT_EN =
  `Summarize the conversation topic in at most ${TITLE_MAX_CHARS} Unicode characters, in English. Output only the title text, no punctuation or explanation.`

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

function isVisibleTitleMessage(msg: Anthropic.MessageParam): boolean {
  return (msg.role === 'user' || msg.role === 'assistant') && extractTextFromMessageContent(msg.content).length > 0
}

/** 标题使用的可见消息口径：排除纯 tool_use / tool_result 消息。 */
export function countVisibleTitleMessagesForSuggest(messages: Anthropic.MessageParam[]): number {
  return messages.filter(isVisibleTitleMessage).length
}

/** 仅 user/assistant 的可见文本，跳过 tool 块；从头累计 N 条 user/assistant 消息 */
export function buildTitleSuggestDialogueText(
  messages: Anthropic.MessageParam[],
  maxMessages: number,
  locale: AppLocale = 'zh-CN'
): string {
  let messageCount = 0
  const lines: string[] = []
  outer: for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    const text = extractTextFromMessageContent(msg.content)
    if (!text) continue
    const label = formatTitleDialogueLabel(msg.role, locale)
    if (text.length > 0) {
      lines.push(`${label}${text}`)
    }
    messageCount += 1
    if (messageCount >= maxMessages) break outer
  }
  return lines.join('\n')
}

/** 历史 user/assistant 数 + 本轮新 user/assistant 数达到阈值。 */
export function reachedCumulativeMessagesForTitleSuggest(
  historicalMessageCount: number,
  currentMessageCount: number
): boolean {
  return historicalMessageCount + currentMessageCount >= TITLE_SUGGEST_TRIGGER_AT_MESSAGE_COUNT
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
  /** 标题落库完成后的界面通知出口；不传即 no-op（落库照常）。 */
  onTitleGenerated?: (session: Session) => void
  sessionId: string
  model: string
  baseUrl?: string
  messagesForApi: Anthropic.MessageParam[]
  getApiKey: () => Promise<string | null>
}): Promise<boolean> {
  const { db, onTitleGenerated, sessionId, model, baseUrl, messagesForApi, getApiKey } = args
  const locale = readAppLocale(db)

  const cur = getSession(db, sessionId)
  if (!cur) return Promise.resolve(false)
  if (cur.metadata?.[SESSION_META_TITLE_GENERATED] === true) return Promise.resolve(false)
  if (cur.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return Promise.resolve(false)
  if (inFlightSessionIds.has(sessionId)) return Promise.resolve(false)

const dialogue = buildTitleSuggestDialogueText(messagesForApi, TITLE_SUGGEST_MAX_MESSAGES, locale)
  if (!dialogue.trim()) return Promise.resolve(false)

  inFlightSessionIds.add(sessionId)

  return (async () => {
    try {
      const apiKey = await getApiKey()
      if (!apiKey) return false

      const fresh = getSession(db, sessionId)
      if (!fresh) return false
      if (fresh.metadata?.[SESSION_META_TITLE_GENERATED] === true) return false
      if (fresh.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return false

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

      if (!title) return false

      const again = getSession(db, sessionId)
      if (!again) return false
      if (again.metadata?.[SESSION_META_TITLE_GENERATED] === true) return false
      if (again.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return false

      const updated = updateSession(db, sessionId, {
        name: title,
        metadata: { ...again.metadata, [SESSION_META_TITLE_GENERATED]: true }
      })
      if (updated) {
        onTitleGenerated?.(updated)
        return true
      }
      return false
    } catch {
      // 静默忽略；打开补全标记由调用方在失败时撤销，使下次打开可重试。
      return false
    } finally {
      inFlightSessionIds.delete(sessionId)
    }
  })()
}

/**
 * 老会话首次打开：若从未自动生成标题、未标用户自定义、已有足够 user/assistant 消息，
 * 则从 DB 拉消息并异步摘要；失败时清除 `titleOpenBackfillAttempted`，使后续打开可重试。
 * @returns 若写入了 metadata，返回更新后的 Session 供渲染进程合并
 */
export function scheduleSessionTitleOpenBackfillIfNeeded(args: {
  db: AppDatabase
  onTitleGenerated?: (session: Session) => void
  sessionId: string
  baseUrl?: string
  getApiKey: () => Promise<string | null>
}): Session | undefined {
  const { db, onTitleGenerated, sessionId, baseUrl, getApiKey } = args
  const locale = readAppLocale(db)

  const session = getSession(db, sessionId)
  if (!session) return undefined
  if (session.metadata?.[SESSION_META_TITLE_GENERATED] === true) return undefined
  if (session.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return undefined
  if (session.metadata?.[SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED] === true) return undefined
  if (inFlightSessionIds.has(sessionId)) return undefined

  const rowMessages = getMessages(db, sessionId, 10_000, 0)
  const convo = buildClaudeToolChatMessages(rowMessages.filter((message) => message.status !== 'streaming'), {
    onOversizedToolResult: (info) => {
      logHistoryOversizedToolResult({
        sessionId,
        toolUseId: info.toolUseId,
        originalLength: info.originalLength,
        compactedLength: info.compactedLength,
        source: 'session-title-suggest'
      })
    }
  })
  const messagesForApi: Anthropic.MessageParam[] = convo.map((m) => ({
    role: m.role as Anthropic.MessageParam['role'],
    content: m.content as Anthropic.MessageParam['content']
  }))

  if (countVisibleTitleMessagesForSuggest(messagesForApi) < TITLE_SUGGEST_MAX_MESSAGES) return undefined

  const dialogue = buildTitleSuggestDialogueText(messagesForApi, TITLE_SUGGEST_MAX_MESSAGES, locale)
  if (!dialogue.trim()) return undefined

  const metaNext: Record<string, unknown> = { ...session.metadata, [SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED]: true }

  const marked = updateSession(db, sessionId, { metadata: metaNext })
  if (!marked) return undefined

  void scheduleSessionTitleSuggestion({
    db,
    onTitleGenerated,
    sessionId,
    model: session.model,
    baseUrl,
    messagesForApi,
    getApiKey
  }).then((succeeded) => {
    if (succeeded) return
    const latest = getSession(db, sessionId)
    if (!latest || latest.metadata?.[SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED] !== true) return
    const metadata = { ...latest.metadata }
    delete metadata[SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED]
    updateSession(db, sessionId, { metadata })
  })

  return getSession(db, sessionId)
}
