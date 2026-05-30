import type { FeishuRemoteConfirmPolicy } from './feishuTypes'
import type { FeishuBrowserRemoteHint } from './browserRemotePolicy'

export function buildFeishuRemoteSystemAppendix(opts: {
  messageId: string
  confirmPolicy: FeishuRemoteConfirmPolicy
  browserRemoteHint?: FeishuBrowserRemoteHint
}): string {
  let browserHint = ''
  if (opts.browserRemoteHint === 'available') {
    browserHint = `
网页访问：已启用 browser 工具。用户给出 http(s) 链接时，优先用 browser（navigate + extract）读取页面；勿用 run_script 抓网页，勿声称无法访问外部 URL。`
  } else if (opts.browserRemoteHint === 'blocked') {
    browserHint = `
网页访问：browser 工具已注入，但飞书远程执行默认关闭。用户要求访问 http(s) 链接时，请调用 browser；若返回未启用远程浏览器之错误，将错误说明转告用户（勿声称无 browser 工具，勿用 run_script 抓网页）。`
  }
  return `
<feishu_remote_command>
来源：飞书 Bot 远程指令。
完成后：用 run_lark_cli 向 message_id=${opts.messageId} 回复摘要（api POST .../reply --as bot）。
写操作：当前 remoteConfirmPolicy=${opts.confirmPolicy}，禁止未确认的飞书写操作。${browserHint}
</feishu_remote_command>`
}

export const FEISHU_MINUTES_TODO_SKILL_HINT = `
<feishu_minutes_todo>
妙记待办提取流程：
1. 用 run_lark_cli 拉取逐字稿（meeting minutes 或 api GET）
2. 提取待办列表并向用户展示计划
3. 逐项执行（受 confirm 策略约束）
</feishu_minutes_todo>`
