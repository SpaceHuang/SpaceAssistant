import { useEffect, useState } from 'react'
import { Drawer, Tabs } from 'antd'
import { FeishuAuditTable } from '../Config/FeishuAuditDrawer'
import { WeChatAuditTable } from '../Config/WeChatAuditDrawer'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type RemoteAuditChannel = 'feishu' | 'wechat'

type Props = {
  open: boolean
  onClose: () => void
  initialChannel?: RemoteAuditChannel
  showFeishu?: boolean
  showWechat?: boolean
}

export function RemoteAuditDrawer({
  open,
  onClose,
  initialChannel = 'feishu',
  showFeishu = true,
  showWechat = true
}: Props) {
  const { t } = useTypedTranslation('config')
  const [channel, setChannel] = useState<RemoteAuditChannel>(initialChannel)
  const dualChannel = showFeishu && showWechat

  useEffect(() => {
    if (open) setChannel(initialChannel)
  }, [open, initialChannel])

  if (!dualChannel) {
    if (showWechat && !showFeishu) {
      return (
        <Drawer
          title={t('wechatAudit.title')}
          width={720}
          open={open}
          onClose={onClose}
        >
          {open ? <WeChatAuditTable /> : null}
        </Drawer>
      )
    }
    return (
      <Drawer
        title={t('feishuAudit.title')}
        width={720}
        open={open}
        onClose={onClose}
      >
        {open ? <FeishuAuditTable /> : null}
      </Drawer>
    )
  }

  return (
    <Drawer
      title={t('remoteAudit.title')}
      width={720}
      open={open}
      onClose={onClose}
    >
      <Tabs
        activeKey={channel}
        onChange={(key) => setChannel(key as RemoteAuditChannel)}
        items={[
          { key: 'feishu', label: t('remoteAudit.tabFeishu'), children: open ? <FeishuAuditTable /> : null },
          { key: 'wechat', label: t('remoteAudit.tabWechat'), children: open ? <WeChatAuditTable /> : null }
        ]}
      />
    </Drawer>
  )
}
