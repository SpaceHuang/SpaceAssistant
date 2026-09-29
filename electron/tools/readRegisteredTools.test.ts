import { describe, expect, it, vi } from 'vitest'
import { buildReadExecutionPermit, type ReadExecutionPermit } from '../confirmation/readExecutionPermit'
import { createReadRegisteredTools } from './readRegisteredTools'
import { executeRegisteredTool } from './toolInvocationCoordinator'

function makePermit(
  input: Record<string, unknown>, normalizedPath = '/tmp/read.txt',
  toolName: ReadExecutionPermit['toolName'] = 'read_file', requestId = 'request-read', toolUseId = 'call-read'
): ReadExecutionPermit {
  return buildReadExecutionPermit({
    requestId, toolUseId, toolName, input,
    facts: [{
      factId: 'fact-read-1', decisionRuleId: 'read-group-workdir-allow', normalizedPath,
      zone: 'workdir-normal', targetKind: 'file',
      identity: { dev: 1, ino: 2, mode: 0o100644, size: 12, mtimeMs: 1 }
    }]
  })
}

describe('read registered adapters', () => {
  it.each(['read_file', 'list_directory', 'grep', 'read_feishu_attachment'] as const)('%s 拒绝确认后替换的 ReadExecutionPermit，且在 dispatch 与 executor 前关闭', async (toolName) => {
    const input = toolName === 'grep'
      ? { path: '/tmp/read.txt', pattern: 'needle' }
      : toolName === 'read_feishu_attachment' ? { attachmentId: 'attachment-read' } : { path: '/tmp/read.txt' }
    const requestId = `request-${toolName}`
    const toolUseId = `call-${toolName}`
    const executors = {
      readFile: vi.fn(async () => ({ success: true, data: 'unexpected' })),
      listDirectory: vi.fn(async () => ({ success: true, data: 'unexpected' })),
      grep: vi.fn(async () => ({ success: true, data: 'unexpected' })),
      readFeishuAttachment: vi.fn(async () => ({ success: true, data: 'unexpected' }))
    }
    const tool = createReadRegisteredTools({
      readFile: { name: 'read_file', execute: executors.readFile } as never,
      listDirectory: { name: 'list_directory', execute: executors.listDirectory } as never,
      grep: { name: 'grep', execute: executors.grep } as never,
      readFeishuAttachment: { name: 'read_feishu_attachment', execute: executors.readFeishuAttachment } as never
    }).find((entry) => entry.name === toolName)!
    const executor = executors[{ read_file: 'readFile', list_directory: 'listDirectory', grep: 'grep', read_feishu_attachment: 'readFeishuAttachment' }[toolName]]
    const runtime = { readExecutionPermit: makePermit(input, '/tmp/read.txt', toolName, requestId, toolUseId) }
    let dispatchEntered = false
    await expect(executeRegisteredTool(tool!, input, {
      requestId, toolUseId, signal: new AbortController().signal,
      executionContext: runtime as never
    }, {
      confirm: async () => {
        runtime.readExecutionPermit = makePermit(input, '/tmp/replaced.txt', toolName, requestId, toolUseId)
        return true
      },
      dispatch: async (_handle, _context, run) => {
        dispatchEntered = true
        return run(new AbortController().signal)
      }
    })).rejects.toThrow('READ_PREPARED_PERMIT_CHANGED')
    expect(dispatchEntered).toBe(false)
    expect(executor).not.toHaveBeenCalled()
  })

  it.each(['read_file', 'list_directory', 'grep', 'read_feishu_attachment'] as const)('%s 将 admission lease signal 交给原 read executor', async (toolName) => {
    const input = toolName === 'grep'
      ? { path: '/tmp/read.txt', pattern: 'needle' }
      : toolName === 'read_feishu_attachment' ? { attachmentId: 'attachment-read' } : { path: '/tmp/read.txt' }
    const requestId = `request-${toolName}`
    const toolUseId = `call-${toolName}`
    const permit = makePermit(input, '/tmp/read.txt', toolName, requestId, toolUseId)
    const executors = {
      readFile: vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => ({ success: true, data: { signal: context.signal } })),
      listDirectory: vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => ({ success: true, data: { signal: context.signal } })),
      grep: vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => ({ success: true, data: { signal: context.signal } })),
      readFeishuAttachment: vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => ({ success: true, data: { signal: context.signal } }))
    }
    const tool = createReadRegisteredTools({
      readFile: { name: 'read_file', execute: executors.readFile } as never,
      listDirectory: { name: 'list_directory', execute: executors.listDirectory } as never,
      grep: { name: 'grep', execute: executors.grep } as never,
      readFeishuAttachment: { name: 'read_feishu_attachment', execute: executors.readFeishuAttachment } as never
    }).find((entry) => entry.name === toolName)!
    const execute = executors[{ read_file: 'readFile', list_directory: 'listDirectory', grep: 'grep', read_feishu_attachment: 'readFeishuAttachment' }[toolName]]
    const runtime = { readExecutionPermit: permit }
    const leaseController = new AbortController()
    await expect(executeRegisteredTool(tool!, input, {
      requestId, toolUseId, signal: new AbortController().signal,
      executionContext: runtime as never
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, run) => run(leaseController.signal)
    })).resolves.toMatchObject({ success: true, data: { signal: leaseController.signal } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual(input)
  })
})
