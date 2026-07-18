import { useState } from 'react'
import { App, Button, Checkbox, Modal } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  sessionId: string
  disabled?: boolean
}

export function SessionArtifactsCleanAction({ sessionId, disabled }: Props) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('detailPanel')
  const [open, setOpen] = useState(false)
  const [includeReferences, setIncludeReferences] = useState(false)
  const [confirmReferences, setConfirmReferences] = useState(false)

  const reset = () => {
    setOpen(false)
    setIncludeReferences(false)
    setConfirmReferences(false)
  }

  const runClean = async () => {
    const result = await window.api.artifactCleanSession({ sessionId, includeReferences })
    message.success(t('sessionArtifacts.cleanDone', { count: result.deleted.length }))
    reset()
  }

  const handlePrimaryOk = async () => {
    if (!includeReferences) {
      await runClean()
      return
    }
    setOpen(false)
    setConfirmReferences(true)
  }

  return (
    <>
      <Button size="small" disabled={disabled} onClick={() => setOpen(true)}>
        {t('sessionArtifacts.cleanScratch')}
      </Button>
      <Modal
        open={open}
        title={t('sessionArtifacts.cleanConfirmTitle')}
        okText={t('sessionArtifacts.cleanConfirmOk')}
        cancelText={t('sessionArtifacts.cleanConfirmCancel')}
        onCancel={reset}
        onOk={() => void handlePrimaryOk().catch(() => {})}
      >
        <p>{t('sessionArtifacts.cleanConfirmContent')}</p>
        <Checkbox checked={includeReferences} onChange={(event) => setIncludeReferences(event.target.checked)}>
          {t('sessionArtifacts.includeReferences')}
        </Checkbox>
      </Modal>
      <Modal
        open={confirmReferences}
        title={t('sessionArtifacts.includeReferencesConfirmTitle')}
        okText={t('sessionArtifacts.cleanConfirmOk')}
        cancelText={t('sessionArtifacts.cleanConfirmCancel')}
        onCancel={reset}
        onOk={() => void runClean().catch((error) => message.error(error instanceof Error ? error.message : String(error)))}
      >
        <p>{t('sessionArtifacts.includeReferencesConfirmContent')}</p>
      </Modal>
    </>
  )
}
