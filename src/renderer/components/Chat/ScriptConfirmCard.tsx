import { useId, useState } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { ScriptCodePreview, ScriptTimeoutMeta } from './ScriptCodePreview'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
  reasonLabel?: string
}

const FINDING_CLASS_KEYS = {
  'process-creation': 'confirm.script.findings.classes.processCreation',
  'destructive-fs': 'confirm.script.findings.classes.destructiveFs',
  'dynamic-execution': 'confirm.script.findings.classes.dynamicExecution',
  'dynamic-import': 'confirm.script.findings.classes.dynamicImport',
  'native-code-load': 'confirm.script.findings.classes.nativeCodeLoad',
  'network-api': 'confirm.script.findings.classes.networkApi',
  'file-write': 'confirm.script.findings.classes.fileWrite',
  'cwd-change': 'confirm.script.findings.classes.cwdChange',
  reflection: 'confirm.script.findings.classes.reflection',
  'alias-resolution': 'confirm.script.findings.classes.aliasResolution',
  'decode-then-exec': 'confirm.script.findings.classes.decodeThenExec',
  'dynamic-dispatch': 'confirm.script.findings.classes.dynamicDispatch'
} as const

export function ScriptConfirmCard({ record, onConfirm, reasonLabel }: Props) {
  const { t } = useTypedTranslation('chat')
  const [findingsExpanded, setFindingsExpanded] = useState(false)
  const findingsListId = useId()

  const code = typeof record.input.code === 'string' ? record.input.code : ''
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const pathHint = typeof record.scriptPathHint === 'string' ? record.scriptPathHint.trim() : ''
  const findings = record.scriptFindings ?? []
  const visibleFindings = findingsExpanded ? findings : findings.slice(0, 3)
  const hiddenFindingCount = Math.max(0, findings.length - 3)

  return (
    <div className="write-confirm-card script-confirm-card">
      {reasonLabel ? <p className="write-confirm-card__reason">{reasonLabel}</p> : null}
      <ConfirmCardDecision
        actionSummary={t('confirm.script.actionSummary')}
        allowLabel={t('confirm.script.allow')}
        denyLabel={t('confirm.script.deny')}
        onConfirm={onConfirm}
      >
        <div className="write-confirm-card__subject script-confirm-card__subject">
          {pathHint ? <p className="write-confirm-card__subject-note script-confirm-card__path-hint">{pathHint}</p> : null}
          {findings.length > 0 ? (
            <section className="script-confirm-card__findings" role="region" aria-labelledby={`${findingsListId}-title`}>
              <h3 className="script-confirm-card__findings-title" id={`${findingsListId}-title`}>
                {t('confirm.script.findings.title')}
              </h3>
              <ol className="script-confirm-card__findings-list" id={findingsListId}>
                {visibleFindings.map((finding, index) => (
                  <li className="script-confirm-card__finding" key={`${finding.pattern}:${finding.range.startLine}:${finding.range.startCol}:${index}`}>
                    <span className="script-confirm-card__finding-location">{t('confirm.script.findings.location', { line: finding.range.startLine })}</span>
                    <code className="script-confirm-card__finding-snippet">{finding.snippet}</code>
                    <span className="script-confirm-card__finding-class">{t(FINDING_CLASS_KEYS[finding.class])}</span>
                  </li>
                ))}
              </ol>
              {hiddenFindingCount > 0 ? (
                <button
                  aria-controls={findingsListId}
                  aria-expanded={findingsExpanded}
                  className="script-confirm-card__findings-toggle"
                  onClick={() => setFindingsExpanded((expanded) => !expanded)}
                  type="button"
                >
                  {findingsExpanded ? t('confirm.script.findings.collapse') : t('confirm.script.findings.expand', { count: hiddenFindingCount })}
                </button>
              ) : null}
            </section>
          ) : null}
          <div className="write-confirm-card__subject-value write-confirm-card__subject-value--code write-confirm-card__command--code">
            <ScriptCodePreview code={code} />
          </div>
          {timeout !== undefined ? <ScriptTimeoutMeta timeout={timeout} /> : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
