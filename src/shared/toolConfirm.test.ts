import { describe, expect, it } from 'vitest'
import type { ToolConfirmHandler, ToolConfirmOptions } from './toolConfirm'

describe('ToolConfirmOptions（确认卡片回传记忆档位）', () => {
  it('允许携带 memoryTier（规范化缓存键）', () => {
    const options: ToolConfirmOptions = {
      memoryTier: { kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' }
    }
    expect(options.memoryTier?.kind).toBe('shell-command')
  })

  it('ToolConfirmHandler 接受 (approved, options?)', () => {
    const handler: ToolConfirmHandler = (_approved, options) => {
      void options?.memoryTier
    }
    expect(typeof handler).toBe('function')
  })
})
