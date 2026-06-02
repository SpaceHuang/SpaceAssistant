import type { Session } from '../../../shared/domainTypes'
import { sessionDisplayName, truncateSessionTitle } from '../../utils/sessionDisplay'
import { SaDangerConfirmModal } from '../ui/SaDangerConfirmModal'

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
  const label = session ? sessionDisplayName(session.name) : ''
  const short = truncateSessionTitle(label)

  return (
    <SaDangerConfirmModal
      open={session != null}
      title="删除会话"
      okText="删除会话"
      confirmLoading={confirmLoading}
      onOk={onConfirm}
      onCancel={onCancel}
    >
      <p className="sa-confirm-modal__name">「{short}」</p>
      {running ? (
        <>
          <p className="sa-confirm-modal__message">该会话正在执行，删除将中止运行。</p>
          <p className="sa-confirm-modal__note sa-confirm-modal__note--warning">
            全部消息将清除且不可恢复。
          </p>
        </>
      ) : (
        <p className="sa-confirm-modal__message">全部消息将清除且不可恢复。</p>
      )}
    </SaDangerConfirmModal>
  )
}
