import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { formatToolLabel } from './toolCallDisplay'
import { sanitizeCapabilityParamsForDisplay } from '../../../shared/capabilityParamSanitize'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: ToolConfirmHandler
}

const PARAMS_PREVIEW_MAX = 600

/**
 * 通用确认兜底卡：任何进入 confirming 状态但没有专用确认卡的工具都渲染此卡。
 * 专用卡（write/shell/script/browser/lark/mcp/toolkit/read）提供丰富展示；
 * 本卡保证「批准入口」不随新工具/新规则遗漏——白名单枚举制的结构性补位（真机验证缺陷教训）。
 */
export function GenericConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const actionSummary = formatToolLabel(record.toolName, record.input, t, record.mcp)
  let paramsPreview = ''
  try {
    // 参数脱敏（吸收远端 93d133a5 的 sanitize 增强）：凭据类入参只出存在性布尔
    paramsPreview = JSON.stringify(sanitizeCapabilityParamsForDisplay(record.input), null, 2)
    if (paramsPreview.length > PARAMS_PREVIEW_MAX) paramsPreview = paramsPreview.slice(0, PARAMS_PREVIEW_MAX) + '\n…'
  } catch {
    paramsPreview = ''
  }

  return (
    <div className="generic-confirm-card">
      <ConfirmCardDecision
        actionSummary={actionSummary}
        allowLabel={t('confirm.generic.allow')}
        denyLabel={t('confirm.generic.deny')}
        onConfirm={onConfirm}
      >
        {paramsPreview ? (
          <pre className="generic-confirm-card__params">{paramsPreview}</pre>
        ) : null}
      </ConfirmCardDecision>
    </div>
  )
}
