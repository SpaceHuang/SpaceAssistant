import { useMemo, useState } from 'react'
import type { ArtifactDecisionRequest, ArtifactDecisionKind } from '../../../shared/artifactDecisionTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  request: ArtifactDecisionRequest
  onRespond: (choice: string) => void
  onCancel: () => void
}

type DecisionLabelKey =
  | 'artifactDecision.optionFile'
  | 'artifactDecision.optionDirectory'
  | 'artifactDecision.optionCustomPath'
  | 'artifactDecision.optionProject'
  | 'artifactDecision.optionPackage'
  | 'artifactDecision.optionScratch'
  | 'artifactDecision.optionOverwrite'
  | 'artifactDecision.optionRename'
  | 'artifactDecision.optionChangeDirectory'
  | 'artifactDecision.optionCancel'
  | 'artifactDecision.optionLongTerm'
  | 'artifactDecision.optionPending'
  | 'artifactDecision.optionAddIgnore'
  | 'artifactDecision.optionKeepVisible'

export function buildArtifactDecisionOptions(
  kind: ArtifactDecisionKind,
  t: (key: DecisionLabelKey) => string
): ArtifactDecisionRequest['options'] {
  switch (kind) {
    case 'path-type':
      return [
        { key: 'file', label: t('artifactDecision.optionFile') },
        { key: 'directory', label: t('artifactDecision.optionDirectory') }
      ]
    case 'output-location':
      return [{ key: 'custom', label: t('artifactDecision.optionCustomPath'), requiresInput: 'directory' }]
    case 'ownership':
      return [
        { key: 'project', label: t('artifactDecision.optionProject') },
        { key: 'package', label: t('artifactDecision.optionPackage') },
        { key: 'scratch', label: t('artifactDecision.optionScratch') }
      ]
    case 'overwrite':
      return [
        { key: 'overwrite', label: t('artifactDecision.optionOverwrite') },
        { key: 'rename', label: t('artifactDecision.optionRename'), requiresInput: 'rename' },
        { key: 'change-directory', label: t('artifactDecision.optionChangeDirectory'), requiresInput: 'directory' },
        { key: 'cancel', label: t('artifactDecision.optionCancel') }
      ]
    case 'reference-retention':
      return [
        { key: 'long-term', label: t('artifactDecision.optionLongTerm') },
        { key: 'pending', label: t('artifactDecision.optionPending') },
        { key: 'cancel', label: t('artifactDecision.optionCancel') }
      ]
    case 'git-ignore':
      return [
        { key: 'add-ignore', label: t('artifactDecision.optionAddIgnore') },
        { key: 'keep-visible', label: t('artifactDecision.optionKeepVisible') },
        { key: 'cancel', label: t('artifactDecision.optionCancel') }
      ]
    default:
      return []
  }
}

export function ArtifactDecisionCard({ request, onRespond, onCancel }: Props) {
  const { t } = useTypedTranslation('chat')
  const [renameValue, setRenameValue] = useState('')
  const [directoryValue, setDirectoryValue] = useState('')

  const title = useMemo(() => {
    switch (request.kind) {
      case 'path-type':
        return t('artifactDecision.pathTypeTitle')
      case 'output-location':
        return t('artifactDecision.outputLocationTitle')
      case 'ownership':
        return t('artifactDecision.ownershipTitle')
      case 'overwrite':
        return t('artifactDecision.overwriteTitle')
      case 'reference-retention':
        return t('artifactDecision.referenceRetentionTitle')
      case 'git-ignore':
        return t('artifactDecision.gitIgnoreTitle')
      default:
        return t('artifactDecision.defaultTitle')
    }
  }, [request.kind, t])

  const handleOption = (option: ArtifactDecisionRequest['options'][number]) => {
    if (option.requiresInput === 'rename') {
      const name = renameValue.trim()
      if (!name || /[\\/]/.test(name)) return
      onRespond(`rename:${name}`)
      return
    }
    if (option.requiresInput === 'directory') {
      const dir = directoryValue.trim().replace(/\\/g, '/')
      if (!dir || dir.startsWith('/') || dir.split('/').includes('..')) return
      onRespond(`change-directory:${dir.replace(/\/+$/, '')}`)
      return
    }
    onRespond(option.key)
  }

  return (
    <div className="artifact-decision-card">
      <div className="artifact-decision-card__title">{title}</div>
      {request.message ? <div className="artifact-decision-card__message">{request.message}</div> : null}
      <div className="artifact-decision-card__options">
        {request.options.map((option) => (
          <div key={option.key} className="artifact-decision-card__option">
            <button type="button" className="artifact-decision-card__button" onClick={() => handleOption(option)}>
              {option.label}
            </button>
            {option.requiresInput === 'rename' ? (
              <input
                className="artifact-decision-card__input"
                value={renameValue}
                placeholder={t('artifactDecision.renamePlaceholder')}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            ) : null}
            {option.requiresInput === 'directory' ? (
              <input
                className="artifact-decision-card__input"
                value={directoryValue}
                placeholder={t('artifactDecision.directoryPlaceholder')}
                onChange={(event) => setDirectoryValue(event.target.value)}
              />
            ) : null}
          </div>
        ))}
      </div>
      <button type="button" className="artifact-decision-card__cancel" onClick={onCancel}>
        {t('artifactDecision.cancel')}
      </button>
    </div>
  )
}
