import { useTypedSelector, useAppDispatch } from '../../hooks'
import { setAboutOpen } from '../../store/configSlice'
import { Button, Modal, Typography } from 'antd'

const { Paragraph, Text } = Typography

export function AboutModal() {
  const open = useTypedSelector((s) => s.config.aboutOpen)
  const dispatch = useAppDispatch()

  return (
    <Modal title="关于 SpaceAssistant" open={open} footer={null} onCancel={() => dispatch(setAboutOpen(false))}>
      <Paragraph>
        <Text strong>SpaceAssistant</Text> 0.1.0
      </Paragraph>
      <Paragraph type="secondary">基于 Electron + React + Claude API 的本地助手。</Paragraph>
    </Modal>
  )
}
