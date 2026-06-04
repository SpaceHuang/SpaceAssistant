import { Modal } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import '../ui/saConfirmModal.css'

interface DeleteConfirmModalProps {
  open: boolean
  name: string
  isDirectory: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function DeleteConfirmModal({ open, name, isDirectory, onConfirm, onCancel }: DeleteConfirmModalProps) {
  const { t } = useTypedTranslation('fileTree')
  const { t: tc } = useTypedTranslation('common')
  const description = isDirectory
    ? t('deleteConfirm.directoryBody', { name })
    : t('deleteConfirm.fileBody', { name })

  return (
    <Modal
      className="sa-confirm-modal"
      open={open}
      title={t('deleteConfirm.title')}
      width={400}
      centered
      onCancel={onCancel}
      okText={tc('delete')}
      cancelText={tc('cancel')}
      okButtonProps={{ danger: true }}
      onOk={onConfirm}
      destroyOnHidden
    >
      <p className="sa-confirm-modal__message">{description}</p>
    </Modal>
  )
}
