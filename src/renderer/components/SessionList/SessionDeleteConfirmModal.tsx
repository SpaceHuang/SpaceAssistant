import type { Session } from '../../../shared/domainTypes'
import { sessionDisplayName, truncateSessionTitle } from '../../utils/sessionDisplay'
import { SaDangerConfirmModal } from '../ui/SaDangerConfirmModal'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  session: Session | null
  running: boolean
  confirmLoading?: boolean
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export function SessionDeleteConfirmModal({
  session,
  running,
  confirmLoading,
  onConfirm,
  onCancel
}: Props) {
  const { t } = useTypedTranslation('common')
  const label = session ? sessionDisplayName(session.name) : ''
  const short = truncateSessionTitle(label)

  return (
    <SaDangerConfirmModal
      open={session != null}
      title={t('session.deleteTitle')}
      okText={t('session.deleteOk')}
      confirmLoading={confirmLoading}
      onOk={onConfirm}
      onCancel={onCancel}
    >
      <p className="sa-confirm-modal__name">「{short}」</p>
      {running ? (
        <>
          <p className="sa-confirm-modal__message">{t('session.deleteRunningWarning')}</p>
          <p className="sa-confirm-modal__note sa-confirm-modal__note--warning">
            {t('session.deletePermanentNote')}
          </p>
        </>
      ) : (
        <p className="sa-confirm-modal__message">{t('session.deletePermanentNote')}</p>
      )}
    </SaDangerConfirmModal>
  )
}
