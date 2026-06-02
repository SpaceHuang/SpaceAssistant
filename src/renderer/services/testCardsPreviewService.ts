import type { AppDispatch } from '../store'
import { addMessage } from '../store/chatSlice'
import { CURRENT_SCHEMA_VERSION, type Message } from '../../shared/domainTypes'
import { getAllTestCardFixtures } from './testCardsFixtures'

const PREVIEW_DELAY_MS = 400

let previewRunning = false

export function isTestCardsPreviewRunning(): boolean {
  return previewRunning
}

export function cancelTestCardsPreview(): void {
  previewRunning = false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type RunTestCardsPreviewDeps = {
  sessionId: string
  text: string
  dispatch: AppDispatch
  scrollBottom: () => void
  onPreviewMessageId: (messageId: string) => void
  persistSystemHint: (text: string) => Promise<void>
}

export async function runTestCardsPreview(deps: RunTestCardsPreviewDeps): Promise<void> {
  if (previewRunning) {
    await deps.persistSystemHint('[Dev] 测试卡片预览进行中，请稍候…')
    return
  }

  previewRunning = true
  const fixtures = getAllTestCardFixtures()

  try {
    const userMsg: Message = {
      id: crypto.randomUUID(),
      sessionId: deps.sessionId,
      role: 'user',
      content: deps.text,
      timestamp: Date.now(),
      status: 'sent',
      schemaVersion: CURRENT_SCHEMA_VERSION
    }
    deps.dispatch(addMessage(userMsg))
    await window.api.chatAppendMessage(userMsg)

    await deps.persistSystemHint(`[Dev] 开始展示 ${fixtures.length} 张测试卡片…`)

    for (const fixture of fixtures) {
      if (!previewRunning) break
      await sleep(PREVIEW_DELAY_MS)
      if (!previewRunning) break

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        sessionId: deps.sessionId,
        role: 'assistant',
        content: fixture.label,
        toolCalls: [fixture.toolCall],
        timestamp: Date.now(),
        status: 'completed',
        schemaVersion: CURRENT_SCHEMA_VERSION
      }
      deps.onPreviewMessageId(assistantMsg.id)
      deps.dispatch(addMessage(assistantMsg))
      await window.api.chatAppendMessage(assistantMsg)
      deps.scrollBottom()
    }

    if (previewRunning) {
      await deps.persistSystemHint('[Dev] 测试卡片展示完成')
    }
  } finally {
    previewRunning = false
  }
}
