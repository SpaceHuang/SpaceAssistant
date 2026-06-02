import { Modal } from 'antd'
import type { ReactNode } from 'react'
import './saConfirmModal.css'

export type SaDangerConfirmModalProps = {
  open: boolean
  title: string
  okText?: string
  cancelText?: string
  confirmLoading?: boolean
  onOk: () => void | Promise<void>
  onCancel: () => void
  children: ReactNode
}

/** 破坏性操作确认框，视觉与侧栏 / 设置弹窗一致 */
export function SaDangerConfirmModal({
  open,
  title,
  okText = '删除',
  cancelText = '取消',
  confirmLoading = false,
  onOk,
  onCancel,
  children
}: SaDangerConfirmModalProps) {
  return (
    <Modal
      className="sa-confirm-modal"
      open={open}
      title={title}
      width={400}
      centered
      destroyOnHidden
      okText={okText}
      cancelText={cancelText}
      okButtonProps={{ danger: true }}
      confirmLoading={confirmLoading}
      onOk={onOk}
      onCancel={onCancel}
      maskClosable={!confirmLoading}
      closable={!confirmLoading}
    >
      <div className="sa-confirm-modal__body">{children}</div>
    </Modal>
  )
}
