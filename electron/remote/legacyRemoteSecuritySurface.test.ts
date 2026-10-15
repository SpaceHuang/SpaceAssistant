import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RemoteContext } from '../tools/types'

const read = (relativePath: string) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')

describe('legacy channel policy IPC retirement', () => {
  it('does not expose the old remote security plan or dual-write API through preload', () => {
    const preload = read('preload.ts')
    expect(preload).not.toContain('remoteSecurityPlan:')
    expect(preload).not.toContain('remoteSecurityCommit:')
    expect(preload).not.toContain("'remote-security:plan'")
    expect(preload).not.toContain("'remote-security:commit'")
  })

  it('does not register channel-owned remote security plan or commit handlers', () => {
    const feishuIpc = read('feishu/feishuIpc.ts')
    expect(feishuIpc).not.toContain("ipcMain.handle('remote-security:plan'")
    expect(feishuIpc).not.toContain("'remote-security:commit'")
    expect(feishuIpc).not.toContain('commitRemoteSecurityConfig')
  })

  it('does not declare the old channel-owned policy methods on the public API', () => {
    const api = read('../src/shared/api.ts')
    expect(api).not.toContain('remoteSecurityPlan:')
    expect(api).not.toContain('remoteSecurityCommit:')
  })

  it('does not carry a channel confirmation policy in the trusted remote context', () => {
    type HasChannelConfirmPolicy = 'confirmPolicy' extends keyof RemoteContext ? true : false
    expect<HasChannelConfirmPolicy>(false).toBe(false)
  })

  it('does not build channel confirmation policy into production remote contexts', () => {
    expect(read('wechat/weChatIpc.ts')).not.toContain('confirmPolicy: config.remoteConfirmPolicy')
    expect(read('wechat/weChatCommandRouter.ts')).not.toContain('confirmPolicy: input.config.remoteConfirmPolicy')
    expect(read('feishu/feishuIpc.ts')).not.toContain('confirmPolicy: config.remoteConfirmPolicy')
    expect(read('feishu/remoteCommandRouter.ts')).not.toContain('confirmPolicy: input.config.remoteConfirmPolicy')
    expect(fs.existsSync(path.join(__dirname, 'remoteConfirmPolicy.ts'))).toBe(false)
  })

  it('does not read legacy channel security flags in runtime authorization bindings', () => {
    const larkTool = read('tools/runLarkCliRegisteredTool.ts')
    expect(larkTool).not.toMatch(/config\.(?:remoteConfirmPolicy|remoteAllowLocalWrite|remoteDenyOutbound|remoteBrowserRequiresConfirm|remoteBrowserNavigateRequiresConfirm|remoteBrowserActRequiresConfirm|remoteScriptRequiresConfirm|remoteSecurityConfigVersion)/)
  })

  it('does not keep writing channel-owned policy changes into the generic config audit path', () => {
    const configIpc = read('ipc/configIpc.ts')
    expect(configIpc).not.toMatch(/'remote(?:AllowLocalWrite|DenyOutbound|ScriptRequiresConfirm|BrowserRequiresConfirm|BrowserNavigateRequiresConfirm|BrowserActRequiresConfirm)'/)
  })
})
