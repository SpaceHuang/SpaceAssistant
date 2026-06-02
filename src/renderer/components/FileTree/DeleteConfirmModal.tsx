import { Modal } from 'antd'
import '../ui/saConfirmModal.css'

interface DeleteConfirmModalProps {
  open: boolean
  name: string
  isDirectory: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function DeleteConfirmModal({ open, name, isDirectory, onConfirm, onCancel }: DeleteConfirmModalProps) {
  const description = isDirectory
    ? `确定要删除 "${name}" 吗？该目录下所有内容将被一并删除。`
    : `确定要删除 "${name}" 吗？此操作不可撤销。`

  return (
    <Modal
      className="sa-confirm-modal"
      open={open}
      title="确认删除"
      width={400}
      centered
      onCancel={onCancel}
      okText="删除"
      cancelText="取消"
      okButtonProps={{ danger: true }}
      onOk={onConfirm}
      destroyOnHidden
    >
      <p className="sa-confirm-modal__message">{description}</p>
    </Modal>
  )
}
