import { Button, Space } from 'antd'
import type { BrowserDependencyToolError } from '../../../shared/browserTypes'
import { BrowserSetupGuide } from '../Browser/BrowserSetupGuide'
import { useAppDispatch } from '../../hooks'
import { useBrowserDetect } from '../../hooks/useBrowserDetect'
import { openSettings } from '../../store/configSlice'

type Props = {
  dependencyRecovery: BrowserDependencyToolError
}

export function BrowserDependencyGuideCard({ dependencyRecovery }: Props) {
  const dispatch = useAppDispatch()
  const { detect, detecting, refresh } = useBrowserDetect({ seed: dependencyRecovery.detectResult })

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Button
        type="link"
        size="small"
        className="browser-dependency-guide__settings-link"
        onClick={() => dispatch(openSettings({ tab: 'tools', toolsSubTab: 'browser' }))}
      >
        打开设置 → 网络访问
      </Button>
      <BrowserSetupGuide
        detect={detect}
        detecting={detecting}
        onRefresh={async (force) => refresh(force)}
        mode="chat"
      />
    </Space>
  )
}
