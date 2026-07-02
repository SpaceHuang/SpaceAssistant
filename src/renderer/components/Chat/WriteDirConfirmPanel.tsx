import { useState } from 'react'
import type { WriteDirCandidatePayload, WriteDirConfirmChoice } from '../../../shared/api'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

interface Props {
  requestId: string
  sessionId: string
  candidates: WriteDirCandidatePayload[]
  onRespond: (choice: WriteDirConfirmChoice | null) => void
}

const CUSTOM_VALUE = '__custom__'

function formatCandidateLabel(
  candidate: WriteDirCandidatePayload,
  t: (key: 'writeDirConfirm.recentSessionLabel', options: { rel: string }) => string
): string {
  if (candidate.labelKind === 'recentSession') {
    return t('writeDirConfirm.recentSessionLabel', { rel: candidate.label })
  }
  return candidate.label
}

export function WriteDirConfirmPanel({ candidates, onRespond }: Props) {
  const { t } = useTypedTranslation('chat')
  const [selectedKey, setSelectedKey] = useState<string | null>(candidates[0]?.key ?? null)
  const [customMode, setCustomMode] = useState(false)
  const [customDir, setCustomDir] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (customMode) {
      const trimmed = customDir.trim()
      if (!trimmed) {
        setError(t('writeDirConfirm.customRequired'))
        return
      }
      onRespond({ type: 'custom', dir: trimmed })
      return
    }
    if (!selectedKey) {
      setError(t('writeDirConfirm.selectRequired'))
      return
    }
    onRespond({ type: 'candidate', key: selectedKey })
  }

  const selectCandidate = (key: string) => {
    setError(null)
    setCustomMode(false)
    setSelectedKey(key)
  }

  const selectCustom = () => {
    setError(null)
    setCustomMode(true)
  }

  const groupValue = customMode ? CUSTOM_VALUE : selectedKey ?? undefined

  return (
    <article
      className="write-confirm-card write-dir-confirm-card"
      role="region"
      aria-label={t('writeDirConfirm.title')}
    >
      <div className="write-confirm-card__intro write-dir-confirm-card__intro">
        <p className="write-confirm-card__intro-label write-dir-confirm-card__title">
          {t('writeDirConfirm.title')}
        </p>
      </div>
      <p className="write-dir-confirm-card__description">{t('writeDirConfirm.description')}</p>

      <div
        className="write-confirm-card__subject write-dir-confirm-card__options"
        role="radiogroup"
        aria-label={t('writeDirConfirm.title')}
      >
        {candidates.map((c) => {
          const selected = !customMode && selectedKey === c.key
          return (
            <label
              key={c.key}
              className={`write-dir-confirm-card__option${selected ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                className="write-dir-confirm-card__option-input"
                name="write-dir-choice"
                value={c.key}
                checked={groupValue === c.key}
                onChange={() => selectCandidate(c.key)}
              />
              <span className="write-dir-confirm-card__option-key" aria-hidden="true">
                {c.key}
              </span>
              <span className="write-dir-confirm-card__option-body">
                <span className="write-dir-confirm-card__option-label">{formatCandidateLabel(c, t)}</span>
                <span className="write-dir-confirm-card__option-path" title={c.dir}>
                  {c.dir}
                </span>
              </span>
            </label>
          )
        })}

        <label className={`write-dir-confirm-card__option${customMode ? ' is-selected' : ''}`}>
          <input
            type="radio"
            className="write-dir-confirm-card__option-input"
            name="write-dir-choice"
            value={CUSTOM_VALUE}
            checked={groupValue === CUSTOM_VALUE}
            onChange={selectCustom}
          />
          <span className="write-dir-confirm-card__option-key" aria-hidden="true">
            ·
          </span>
          <span className="write-dir-confirm-card__option-body">
            <span className="write-dir-confirm-card__option-label">{t('writeDirConfirm.customOption')}</span>
          </span>
        </label>

        {customMode ? (
          <input
            type="text"
            className="write-dir-confirm-card__custom-input"
            placeholder={t('writeDirConfirm.customPlaceholder')}
            value={customDir}
            onChange={(e) => {
              setCustomDir(e.target.value)
              setError(null)
            }}
            aria-invalid={error === t('writeDirConfirm.customRequired')}
          />
        ) : null}
      </div>

      {error ? (
        <p className="write-dir-confirm-card__error" role="alert">
          {error}
        </p>
      ) : null}

      <div
        className="write-confirm-card__footer"
        role="group"
        aria-label={t('writeDirConfirm.title')}
      >
        <div className="write-confirm-card__actions">
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--deny"
            onClick={() => onRespond(null)}
          >
            {t('writeDirConfirm.cancel')}
          </button>
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--allow"
            onClick={submit}
          >
            {t('writeDirConfirm.confirm')}
          </button>
        </div>
      </div>
    </article>
  )
}
