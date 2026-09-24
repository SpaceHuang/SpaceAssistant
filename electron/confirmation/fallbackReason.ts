/**
 * 回退原因短文案（§5.3）：主进程不产出文案，只产出「键 + 参数」（偏差 13），
 * 经宿主 translate 端口实现从渲染端 i18n 资源（zh-CN / en-US 双份真源）解析。
 * 文案形态为可嵌入 banner 模板的短原因短语（「服务暂不可用」/「等待超时」），
 * 不带模板已承载的「未完成 / 需手动确认」语义，且不得暴露内部状态细节（脱敏要求）。
 */
import { createHostTranslator } from '../i18n/hostTranslate'
import type { AppLocale } from '../../src/shared/locale'
import type { FallbackEligibleCause } from './fallbackToUser'

const REASON_KEYS: Record<FallbackEligibleCause, string> = {
  unavailable: 'notification.approvalFallbackReasonUnavailable',
  timeout: 'notification.approvalFallbackReasonTimeout'
}

const translators = new Map<AppLocale, ReturnType<typeof createHostTranslator>>()

/** 解析回退原因短文案；资源不可达时 hostTranslate 退化为键名（fail-visible），不抛错。 */
export function approvalFallbackReasonFor(cause: FallbackEligibleCause, locale?: AppLocale): string {
  const resolved = locale ?? 'zh-CN'
  let translate = translators.get(resolved)
  if (!translate) {
    translate = createHostTranslator({ locale: resolved })
    translators.set(resolved, translate)
  }
  return translate({ key: REASON_KEYS[cause] })
}
