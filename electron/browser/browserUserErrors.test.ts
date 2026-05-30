import { describe, expect, it } from 'vitest'
import { toBrowserUserError } from './browserUserErrors'

describe('toBrowserUserError', () => {
  it('maps chrome-launcher ESM to compatibility message not install hint', () => {
    const err = new Error(
      'require() of ES Module E:\\Develop\\SpaceAssistant\\node_modules\\chrome-launcher\\dist\\index.js'
    )
    const msg = toBrowserUserError(err, 'init')
    expect(msg).not.toMatch(/playwright install chromium/i)
    expect(msg).toMatch(/模块兼容性|重启应用/)
  })

  it('maps playwright missing executable', () => {
    const msg = toBrowserUserError(
      new Error("Executable doesn't exist at C:\\Users\\x\\ms-playwright\\chromium"),
      'init'
    )
    expect(msg).toMatch(/playwright install chromium|设置 → 浏览器/)
    expect(msg).not.toMatch(/Users/)
    expect(msg).not.toMatch(/项目目录/)
  })

  it('keeps whitelist errors', () => {
    const msg = toBrowserUserError(new Error('域名不在白名单中'), 'navigate')
    expect(msg).toBe('域名不在白名单中')
  })

  it('maps net errors to friendly navigate message', () => {
    const msg = toBrowserUserError(new Error('net::ERR_CONNECTION_RESET'), 'navigate')
    expect(msg).toMatch(/打开页面|超时|网络/)
    expect(msg).not.toMatch(/node_modules/)
  })

  it('uses generic navigate message for internal stack-like text', () => {
    const msg = toBrowserUserError(
      new Error('at launchLocalChrome (E:\\app\\dist-electron\\electron\\browser\\stagehandService.js:42:11)'),
      'navigate'
    )
    expect(msg).not.toMatch(/dist-electron|stagehandService/)
    expect(msg).toMatch(/打开页面失败/)
  })

  it('preserves LLM credential classification', () => {
    const msg = toBrowserUserError(new Error('401 Unauthorized'), 'extract')
    expect(msg).toMatch(/凭证无效/)
  })

  it('maps unsupported stagehand model by error name', () => {
    const err = new Error('Unsupported model.')
    err.name = 'UnsupportedModelError'
    const msg = toBrowserUserError(err, 'init')
    expect(msg).toMatch(/provider\/模型名/)
    expect(msg).not.toMatch(/playwright install/i)
  })

  it('maps cdp undefined errors', () => {
    const msg = toBrowserUserError(new Error('undefined undefined'), 'init')
    expect(msg).toMatch(/CDP 连接失败/)
    expect(msg).not.toMatch(/模块兼容性/)
  })

  it('maps deepseek thinking + tool_choice from responseBody', () => {
    const err = new Error('Bad Request') as Error & { responseBody: string }
    err.name = 'AI_APICallError'
    err.responseBody = JSON.stringify({
      error: { message: 'Thinking mode does not support this tool_choice' }
    })
    const msg = toBrowserUserError(err, 'extract')
    expect(msg).toMatch(/Thinking|思考/)
    expect(msg).toMatch(/deepseek-v4-flash|设置/)
    expect(msg).not.toMatch(/AI_APICallError/)
  })
})
