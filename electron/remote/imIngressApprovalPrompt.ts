import { dialog, type MessageBoxOptions } from 'electron'
import { getMainWindow } from '../windowRef'
import type { ExecutionLane } from '../../src/shared/confirmation/types'

/** Local-owner approval for one inbound IM message. Message text is shown only in this modal and never audited. */
export async function requestImIngressApproval(input: {
  channel: 'wechat' | 'feishu'
  senderId: string
  messageId: string
  ruleId: string
  messageText: string
}): Promise<boolean> {
  const excerpt = input.messageText.replace(/\s+/g, ' ').trim().slice(0, 240)
  const options: MessageBoxOptions = {
    type: 'question',
    title: input.channel === 'wechat' ? '微信消息需要批准' : '飞书消息需要批准',
    message: `规则「${input.ruleId}」要求批准这条消息后才能进入处理。`,
    detail: `发送者：${input.senderId}\n消息编号：${input.messageId}\n\n${excerpt || '（空消息）'}`,
    buttons: ['批准并继续处理此消息', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const parent = getMainWindow()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return result.response === 0
}

/** Local-owner approval for exposing exactly one tool in one lane for this request. */
export async function requestImExposureApproval(input: {
  lane: ExecutionLane
  toolName: string
  ruleId: string
}): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'question',
    title: '确认开放工具',
    message: `规则「${input.ruleId}」要求批准后才能向${input.lane}链路开放此工具。`,
    detail: `链路：${input.lane}\n工具：${input.toolName}\n\n批准仅对本次请求中的此工具生效。`,
    buttons: ['批准并开放此工具', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const parent = getMainWindow()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return result.response === 0
}
