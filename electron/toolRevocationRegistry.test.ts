import { afterEach, describe, expect, it } from 'vitest'
import {
  ToolRevocationRegistry,
  clearToolRevocationRequest,
  isToolRevoked,
  registerToolRevocationRequest,
  revokeToolForAllLanes,
  revokeToolForLane
} from './toolRevocationRegistry'

describe('toolRevocationRegistry', () => {
  afterEach(() => {
    clearToolRevocationRequest('a')
    clearToolRevocationRequest('b')
    clearToolRevocationRequest('c')
  })

  it('关闭工具后旧请求保持撤销，重开不清除撤销事实', () => {
    registerToolRevocationRequest('a', 'desktop', 'a')
    expect(revokeToolForLane('desktop', 'write_file')).toBe(1)
    expect(isToolRevoked('a', 'write_file')).toBe(true)
    // 新请求代表重开后的授权基线，不继承旧请求撤销事实
    registerToolRevocationRequest('b', 'desktop', 'b')
    expect(isToolRevoked('b', 'write_file')).toBe(false)
    expect(isToolRevoked('a', 'write_file')).toBe(true)
  })

  it('按 lane 和工具名隔离撤销', () => {
    registerToolRevocationRequest('a', 'desktop', 'a')
    registerToolRevocationRequest('b', 'wechat', 'b')
    revokeToolForLane('desktop', 'write_file')
    expect(isToolRevoked('a', 'write_file')).toBe(true)
    expect(isToolRevoked('b', 'write_file')).toBe(false)
    expect(isToolRevoked('a', 'read_file')).toBe(false)
  })

  it('全局关闭工具会撤销所有来源的在途请求', () => {
    registerToolRevocationRequest('a', 'desktop', 'a')
    registerToolRevocationRequest('b', 'feishu', 'b')
    registerToolRevocationRequest('c', 'wechat', 'c')
    expect(revokeToolForAllLanes('write_file')).toBe(3)
    expect(isToolRevoked('a', 'write_file')).toBe(true)
    expect(isToolRevoked('b', 'write_file')).toBe(true)
    expect(isToolRevoked('c', 'write_file')).toBe(true)
  })

  it('automation lane participates in global revocation and publishes the revoke synchronously', () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('automation-request', 'automation', 'automation-request')
    const events: unknown[] = []
    const unsubscribe = registry.onRevocation((event) => events.push(event))
    expect(registry.revokeToolForAllLanes('write_file')).toBe(1)
    expect(registry.isToolRevoked('automation-request', 'write_file')).toBe(true)
    expect(events).toEqual([{ requestId: 'automation-request', executionId: 'automation-request', lane: 'automation', toolName: 'write_file' }])
    unsubscribe()
  })

  it('共享 requestId 的不同 turn 保留独立撤销状态，清理一方不移除另一方', () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('shared-request', 'desktop', 'turn-a')
    registry.registerToolRevocationRequest('shared-request', 'feishu', 'turn-b')

    expect(registry.revokeToolForLane('desktop', 'write_file')).toBe(1)
    expect(registry.isToolRevoked('shared-request', 'write_file', 'turn-a')).toBe(true)
    expect(registry.isToolRevoked('shared-request', 'write_file', 'turn-b')).toBe(false)

    registry.clearToolRevocationRequest('shared-request', 'turn-a')
    expect(registry.revokeToolForLane('feishu', 'write_file')).toBe(1)
    expect(registry.isToolRevoked('shared-request', 'write_file', 'turn-b')).toBe(true)
  })
})
