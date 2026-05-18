import { useMemo } from 'react'
import { useTypedSelector } from '../../hooks'
import { isDisposableScript } from './disposableScriptFilter'

export interface ReferencedFile {
  /** 文件相对路径（相对于工作目录），作为唯一标识 */
  path: string
  /** 最近一次操作时间（Unix 毫秒时间戳） */
  lastReferencedAt: number
  /** 操作类型标记：最近一次操作是读还是写 */
  lastOperation: 'read' | 'write'
  /** 该文件被引用的总次数 */
  referenceCount: number
}

const FILE_REFERENCE_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])

function getOperationType(toolName: string): 'read' | 'write' {
  return toolName === 'read_file' ? 'read' : 'write'
}

/** 从消息列表中提取引用文件（纯函数，便于测试） */
export function extractReferencedFiles(messages: import('../../../shared/domainTypes').Message[]): ReferencedFile[] {
  const map = new Map<string, ReferencedFile>()

  for (const msg of messages) {
    if (!msg.toolCalls) continue
    for (const tc of msg.toolCalls) {
      if (tc.status !== 'completed') continue
      if (!FILE_REFERENCE_TOOLS.has(tc.toolName)) continue
      const path = typeof tc.input.path === 'string' ? tc.input.path : ''
      if (!path) continue
      if (isDisposableScript(path)) continue

      const existing = map.get(path)
      const completedAt = tc.completedAt ?? 0
      const operation = getOperationType(tc.toolName)

      if (existing) {
        existing.referenceCount++
        if (completedAt > existing.lastReferencedAt) {
          existing.lastReferencedAt = completedAt
          existing.lastOperation = operation
        }
      } else {
        map.set(path, {
          path,
          lastReferencedAt: completedAt,
          lastOperation: operation,
          referenceCount: 1,
        })
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => b.lastReferencedAt - a.lastReferencedAt)
}

/** 从当前会话消息中派生引用文件列表 */
export function useReferencedFiles(sessionId: string | null): ReferencedFile[] {
  const messages = useTypedSelector((s) => s.chat.messages)

  return useMemo(() => {
    if (!sessionId) return []
    const sessionMessages = messages.filter((m) => m.sessionId === sessionId)
    return extractReferencedFiles(sessionMessages)
  }, [messages, sessionId])
}
