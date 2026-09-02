import { Alert, Button } from 'antd'
import { useAppDispatch } from '../../hooks'
import { openSettings } from '../../store/configSlice'
import type { NamespaceKeyMap } from '../../i18n/types'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

/**
 * 旧设置页的信任/确认管理项快捷入口（P4，§7）：信任管理 UI 由
 * 「安全策略 → 确认记忆管理」取代，旧位置降级为跳转链接（读写同一份配置）。
 */
export function ToolsSecurityShortcut({ hintKey }: { hintKey: NamespaceKeyMap['config'] }) {
  const { t } = useTypedTranslation('config')
  const dispatch = useAppDispatch()
  return (
    <Alert
      type="info"
      showIcon
      className="config-alert--compact config-alert--notice"
      message={t(hintKey)}
      action={
        <Button
          size="small"
          type="primary"
          onClick={() => dispatch(openSettings({ tab: 'tools', toolsSubTab: 'security' }))}
        >
          {t('toolsSecurity.openPage')}
        </Button>
      }
    />
  )
}
