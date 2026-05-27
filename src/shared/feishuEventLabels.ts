import type { FeishuEventConnectionState, FeishuEventStatus } from './feishuTypes'

/** 连接状态中文文案（UI 展示用，勿直接暴露英文枚举） */
export function feishuEventConnectionStateLabel(state: FeishuEventConnectionState): string {
  switch (state) {
    case 'stopped':
      return '已停止'
    case 'connecting':
      return '正在连接'
    case 'connected':
      return '已连接'
    case 'error':
      return '出错'
    default:
      return '未知'
  }
}

export function formatFeishuEventStatusText(status: FeishuEventStatus): string {
  return `${feishuEventConnectionStateLabel(status.state)} · 已处理 ${status.processedCount}`
}
