import type { FeishuRemoteConfirmPolicy } from './feishuTypes'

export function buildFeishuRemoteSystemAppendix(opts: {
  messageId: string
  confirmPolicy: FeishuRemoteConfirmPolicy
}): string {
  return `
<feishu_remote_command>
来源：飞书 Bot 远程指令。
完成后：用 run_lark_cli 向 message_id=${opts.messageId} 回复摘要（api POST .../reply --as bot）。
写操作：当前 remoteConfirmPolicy=${opts.confirmPolicy}，禁止未确认的飞书写操作。
</feishu_remote_command>`
}

export const FEISHU_MINUTES_TODO_SKILL_HINT = `
<feishu_minutes_todo>
妙记待办提取流程：
1. 用 run_lark_cli 拉取逐字稿（meeting minutes 或 api GET）
2. 提取待办列表并向用户展示计划
3. 逐项执行（受 confirm 策略约束）
</feishu_minutes_todo>`
