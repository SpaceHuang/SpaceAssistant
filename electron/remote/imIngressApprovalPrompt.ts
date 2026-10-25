import { BrowserWindow } from 'electron'
import { getMainWindow } from '../windowRef'
import type { ExecutionLane } from '../../src/shared/confirmation/types'
import { isAppLocale, type AppLocale } from '../../src/shared/locale'
import type { AppDatabase } from '../database/sqliteStore'
import { getConfigValue } from '../database'
import { createHostTranslator } from '../i18n/hostTranslate'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

async function requestCancellableApproval(input: { title: string; message: string; detail: string; approveLabel: string; rejectLabel: string; signal?: AbortSignal }): Promise<boolean> {
  if (input.signal?.aborted) return false
  const parent = getMainWindow()
  const prompt = new BrowserWindow({
    width: 520, height: 310, minWidth: 460, minHeight: 280,
    title: input.title, parent: parent ?? undefined, modal: Boolean(parent), show: false,
    resizable: false, minimizable: false, maximizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const body = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
    *{box-sizing:border-box}body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#222;margin:0;padding:24px}h1{font-size:17px;margin:0 0 12px}p{line-height:1.5;white-space:pre-wrap;margin:0 0 12px}.detail{font-size:12px;color:#555;max-height:130px;overflow:auto;border-top:1px solid #ddd;padding-top:10px}.buttons{display:flex;justify-content:flex-end;gap:8px;position:absolute;bottom:20px;right:24px}button{padding:7px 14px}button.primary{font-weight:600}
    </style><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p><div class="detail">${escapeHtml(input.detail)}</div><div class="buttons"><button id="reject">${escapeHtml(input.rejectLabel)}</button><button class="primary" id="approve">${escapeHtml(input.approveLabel)}</button></div><script>
    document.getElementById('reject').onclick=()=>location.href='spaceassistant-approval://reject';document.getElementById('approve').onclick=()=>location.href='spaceassistant-approval://approve';
    </script>`
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (approved: boolean) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener('abort', abort)
      if (!prompt.isDestroyed()) prompt.close()
      resolve(approved)
    }
    const abort = () => finish(false)
    prompt.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (!url.startsWith('spaceassistant-approval://')) return
      finish(url.endsWith('approve'))
    })
    prompt.on('closed', () => finish(false))
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) {
      abort()
      return
    }
    void prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`).then(() => {
      if (!settled) prompt.show()
    }).catch(() => finish(false))
  })
}

function createApprovalTranslator(db?: AppDatabase, locale?: AppLocale) {
  const storedLocale = db ? getConfigValue(db, 'config.locale') : undefined
  const resolvedLocale = locale ?? (storedLocale && isAppLocale(storedLocale) ? storedLocale : 'zh-CN')
  return createHostTranslator({ locale: resolvedLocale })
}

/** Local-owner approval for one inbound IM message. Message text is shown only in this modal and never audited. */
export async function requestImIngressApproval(input: {
  db?: AppDatabase
  locale?: AppLocale
  channel: 'wechat' | 'feishu'
  senderId: string
  messageId: string
  ruleId: string
  messageText: string
  signal?: AbortSignal
}): Promise<boolean> {
  const t = createApprovalTranslator(input.db, input.locale)
  const excerpt = input.messageText.replace(/\s+/g, ' ').trim().slice(0, 240)
  return requestCancellableApproval({
    title: t({ key: input.channel === 'wechat' ? 'approval.ingressWechatTitle' : 'approval.ingressFeishuTitle' }),
    message: t({ key: 'approval.ingressMessage', params: { ruleId: input.ruleId } }),
    detail: t({ key: 'approval.ingressDetails', params: {
      senderId: input.senderId, messageId: input.messageId, excerpt: excerpt || t({ key: 'approval.emptyMessage' })
    } }),
    approveLabel: t({ key: 'approval.ingressApprove' }),
    rejectLabel: t({ key: 'approval.reject' }), signal: input.signal
  })
}

/** Local-owner approval for exposing exactly one tool in one lane for this request. */
export async function requestImExposureApproval(input: {
  db?: AppDatabase
  locale?: AppLocale
  lane: ExecutionLane
  toolName: string
  ruleId: string
  signal?: AbortSignal
}): Promise<boolean> {
  const t = createApprovalTranslator(input.db, input.locale)
  const laneLabel = t({ key: input.lane === 'feishu' ? 'approval.feishuLane' :
    input.lane === 'wechat' ? 'approval.wechatLane' : 'approval.desktopLane' })
  return requestCancellableApproval({
    title: t({ key: 'approval.exposureTitle' }),
    message: t({ key: 'approval.exposureMessage', params: { ruleId: input.ruleId, lane: laneLabel } }),
    detail: t({ key: 'approval.exposureDetails', params: { lane: laneLabel, toolName: input.toolName } }),
    approveLabel: t({ key: 'approval.exposureApprove' }),
    rejectLabel: t({ key: 'approval.reject' }), signal: input.signal })
}
