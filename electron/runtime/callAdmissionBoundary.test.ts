import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * B1(偏差 23 验收):渲染端不可绕过的结构断言——
 * 受理端口 chat:submit-outbound 是桌面唯一发起通道(preload API 面盘点);
 * 四处发起入口(三入口 + 一处嵌套,评审 N2 口径)统一接入调用级准入。
 */

const root = process.cwd()
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf-8')

describe('渲染端 API 面无绕过通道(偏差 23 结构断言)', () => {
  it('preload 暴露的 chat 发起通道唯一:仅 chatSubmitOutbound,无直连 send-stream / create-with-tools', () => {
    const preload = read('electron/preload.ts')
    expect(preload.includes("'chat:submit-outbound'")).toBe(true)
    // 渲染端不得拿到绕过受理端口的发起通道
    expect(preload.includes("'Codex-chat-send-stream'")).toBe(false)
    expect(preload.includes("'Codex-chat-create-with-tools'")).toBe(false)
  })

  it('四处发起入口统一接入准入(桌面受理 / 远端 / 管家 / 嵌套回答者)', () => {
    const acceptor = read('electron/outbound/outboundAcceptor.ts')
    expect(acceptor.includes("lane: 'desktop'")).toBe(true)
    expect(acceptor.includes("disposition: 'reject'")).toBe(true)

    const remote = read('electron/remote/imRemoteAgent.ts')
    expect(remote.includes('admissionGate.acquire')).toBe(true)
    expect(remote.includes("priority: 'interactive'")).toBe(true)

    const butler = read('electron/butler/butlerInvoker.ts')
    expect(butler.includes("lane: 'automation'")).toBe(true)
    expect(butler.includes("priority: 'background'")).toBe(true)

    const channel = read('electron/confirmation/agentChannel.ts')
    expect(channel.includes("role: 'approval-answerer'")).toBe(true)
  })
})
