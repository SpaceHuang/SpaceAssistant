import { afterEach, describe, expect, it } from 'vitest'
import {
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
    registerToolRevocationRequest('a', 'desktop')
    expect(revokeToolForLane('desktop', 'write_file')).toBe(1)
    expect(isToolRevoked('a', 'write_file')).toBe(true)
    // 新请求代表重开后的授权基线，不继承旧请求撤销事实
    registerToolRevocationRequest('b', 'desktop')
    expect(isToolRevoked('b', 'write_file')).toBe(false)
    expect(isToolRevoked('a', 'write_file')).toBe(true)
  })

  it('按 lane 和工具名隔离撤销', () => {
    registerToolRevocationRequest('a', 'desktop')
    registerToolRevocationRequest('b', 'wechat')
    revokeToolForLane('desktop', 'write_file')
    expect(isToolRevoked('a', 'write_file')).toBe(true)
    expect(isToolRevoked('b', 'write_file')).toBe(false)
    expect(isToolRevoked('a', 'read_file')).toBe(false)
  })

  it('全局关闭工具会撤销所有来源的在途请求', () => {
    registerToolRevocationRequest('a', 'desktop')
    registerToolRevocationRequest('b', 'feishu')
    registerToolRevocationRequest('c', 'wechat')
    expect(revokeToolForAllLanes('write_file')).toBe(3)
    expect(isToolRevoked('a', 'write_file')).toBe(true)
    expect(isToolRevoked('b', 'write_file')).toBe(true)
    expect(isToolRevoked('c', 'write_file')).toBe(true)
  })
})
