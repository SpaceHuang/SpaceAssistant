import { useMemo, useState } from 'react'
import { Input, Modal, Radio, Space, Typography } from 'antd'
import type { ArtifactApiItem } from '../../../shared/api'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type RelocateModeChoice = 'move-switch' | 'copy-continue' | 'copy-switch'

type Props = {
  open: boolean
  artifact: ArtifactApiItem | null
  submitting?: boolean
  onCancel: () => void
  onSubmit: (input: { target: string; choice: RelocateModeChoice; overwriteAuthorized: boolean }) => void
}

function toDisplayPath(finalPath: string): string {
  return finalPath.replace(/\\/g, '/')
}

export function describeRelocateChoice(choice: RelocateModeChoice, artifactTitle: string, t: (key: RelocateLabelKey) => string): string {
  if (choice === 'move-switch') return t('sessionArtifacts.relocateChoiceMoveSwitch')
  if (choice === 'copy-continue') return t('sessionArtifacts.relocateChoiceCopyContinue').replace('{{title}}', artifactTitle)
  return t('sessionArtifacts.relocateChoiceCopySwitch')
}

type RelocateLabelKey =
  | 'sessionArtifacts.relocateTitle'
  | 'sessionArtifacts.relocateTarget'
  | 'sessionArtifacts.relocateCurrentEdit'
  | 'sessionArtifacts.relocateChoiceMoveSwitch'
  | 'sessionArtifacts.relocateChoiceCopyContinue'
  | 'sessionArtifacts.relocateChoiceCopySwitch'
  | 'sessionArtifacts.relocateOverwrite'

export function ArtifactRelocateDialog({ open, artifact, submitting, onCancel, onSubmit }: Props) {
  const { t } = useTypedTranslation('detailPanel')
  const [target, setTarget] = useState('')
  const [choice, setChoice] = useState<RelocateModeChoice>('move-switch')
  const [overwriteAuthorized, setOverwriteAuthorized] = useState(false)

  const preview = useMemo(() => {
    if (!artifact) return ''
    if (choice === 'copy-continue') {
      return t('sessionArtifacts.relocateCurrentEdit').replace('{{path}}', toDisplayPath(artifact.finalPath))
    }
    if (choice === 'copy-switch') {
      return t('sessionArtifacts.relocateChoiceCopySwitch')
    }
    return t('sessionArtifacts.relocateChoiceMoveSwitch')
  }, [artifact, choice, t])

  return (
    <Modal
      open={open}
      title={t('sessionArtifacts.relocateTitle')}
      okText={t('sessionArtifacts.relocateConfirm')}
      cancelText={t('sessionArtifacts.relocateCancel')}
      confirmLoading={submitting}
      onCancel={onCancel}
      onOk={() => {
        if (!artifact || !target.trim()) return
        onSubmit({ target: target.trim(), choice, overwriteAuthorized })
      }}
      destroyOnClose
    >
      {artifact ? (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Typography.Text type="secondary">{artifact.title || toDisplayPath(artifact.finalPath)}</Typography.Text>
          </div>
          <Input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={t('sessionArtifacts.relocateTarget')}
          />
          <Radio.Group value={choice} onChange={(event) => setChoice(event.target.value)}>
            <Space direction="vertical">
              <Radio value="move-switch">{t('sessionArtifacts.relocateChoiceMoveSwitch')}</Radio>
              <Radio value="copy-continue">{t('sessionArtifacts.relocateChoiceCopyContinue').replace('{{title}}', artifact.title || toDisplayPath(artifact.finalPath))}</Radio>
              <Radio value="copy-switch">{t('sessionArtifacts.relocateChoiceCopySwitch')}</Radio>
            </Space>
          </Radio.Group>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('sessionArtifacts.relocateCurrentEdit')}: {preview}
          </Typography.Paragraph>
          <label>
            <input type="checkbox" checked={overwriteAuthorized} onChange={(event) => setOverwriteAuthorized(event.target.checked)} />
            {' '}
            {t('sessionArtifacts.relocateOverwrite')}
          </label>
        </Space>
      ) : null}
    </Modal>
  )
}

export function choiceToRelocatePayload(choice: RelocateModeChoice): { mode: 'move' | 'copy'; switchToCopy?: boolean } {
  if (choice === 'move-switch') return { mode: 'move' }
  if (choice === 'copy-continue') return { mode: 'copy', switchToCopy: false }
  return { mode: 'copy', switchToCopy: true }
}
