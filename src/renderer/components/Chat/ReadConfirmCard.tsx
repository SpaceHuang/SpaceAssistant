import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: ToolConfirmHandler
}

function formatPath(record: ToolCallRecord): string {
  // read_feishu_attachment 的 input 键是 attachmentId（非路径），也一并展示，避免摘要落到兜底文案（评审 P3-3）
  const raw = record.input.path ?? record.input.filePath ?? record.input.file_path ?? record.input.attachmentId
  return typeof raw === 'string' && raw.length > 0 ? raw : ''
}

/**
 * 读取类工具（grep / read_file / list_directory / read_feishu_attachment）的敏感路径确认卡。
 * gate 命中 path-sensitive-read-confirm（confirm-every-time，locked）等规则时，工具以 confirming
 * 状态挂起等待真人批准——此前读取类没有确认卡分支，桌面 lane 的批准入口缺失（真机验证发现）。
 */
export function ReadConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const path = formatPath(record)
  const actionSummary = record.toolName === 'grep'
    ? t('confirm.read.grepAction', { path: path || t('confirm.read.fallback') })
    : t('confirm.read.readAction', { path: path || t('confirm.read.fallback') })

  return (
    <div className="read-confirm-card">
      <ConfirmCardDecision
        actionSummary={actionSummary}
        allowLabel={t('confirm.read.allow')}
        denyLabel={t('confirm.read.deny')}
        onConfirm={onConfirm}
      >
        <p className="read-confirm-card__note">{t('confirm.read.sensitiveNote')}</p>
      </ConfirmCardDecision>
    </div>
  )
}
