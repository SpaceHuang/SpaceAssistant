import type { WeChatRemoteConfirmPolicy } from './wechatTypes'
import type { FeishuBrowserRemoteHint } from './browserRemotePolicy'

export function buildWeChatRemoteSystemAppendix(opts: {
  userId: string
  confirmPolicy: WeChatRemoteConfirmPolicy
  browserRemoteHint?: FeishuBrowserRemoteHint
}): string {
  let browserHint = ''
  if (opts.browserRemoteHint === 'available') {
    browserHint = `
网页访问：已启用 browser 工具。用户给出 http(s) 链接时，优先用 browser（navigate + extract）读取页面；勿用 run_script 抓网页，勿声称无法访问外部 URL。`
  } else if (opts.browserRemoteHint === 'blocked') {
    browserHint = `
网页访问：browser 工具已注入，但微信远程执行默认关闭。用户要求访问 http(s) 链接时，请调用 browser；若返回未启用远程浏览器之错误，将错误说明转告用户。`
  }
  return `
<wechat_remote_command>
来源：微信 iLink Bot 远程指令（手机微信）
回复要求：执行完成后由系统将摘要发回微信；不要假设用户能看到桌面界面
安全：当前会话 source=wechat，写操作确认策略见 wechat.remoteConfirmPolicy=${opts.confirmPolicy}
输出：使用简洁中文纯文本，避免复杂 Markdown
用户 ID：${opts.userId}${browserHint}
</wechat_remote_command>`
}

export const WECHAT_REMOTE_SKILL_HINT = `
<wechat_remote>
微信远程指令约束：
- 回复长度建议控制在 2000 字以内
- 避免 Markdown 表格与复杂格式
- 出站消息使用 wechat_reply / wechat_send 工具，调用即发送。
</wechat_remote>`
