import { App, Button, Space, Typography } from 'antd'
import type { BrowserDependencyToolError } from '../../../shared/browserTypes'

type Props = {
  dependencyRecovery: BrowserDependencyToolError
}

export function BrowserDependencyGuideCard({ dependencyRecovery }: Props) {
  const { message } = App.useApp()

  return (
    <div className="browser-dependency-guide-card">
      <Typography.Text type="warning" strong>
        ⚠ 网络访问依赖未就绪
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8, marginTop: 4 }}>
        助手将代为运行安装命令（需你确认）；若 Shell 未启用，可使用下方按钮在终端中手动操作。
      </Typography.Paragraph>
      <Space>
        {typeof window.api?.browserOpenTerminal === 'function' ? (
          <Button
            size="small"
            onClick={() => {
              void window.api.browserOpenTerminal().then((r) => {
                if (!r.ok) message.error(r.error)
              })
            }}
          >
            在终端中打开
          </Button>
        ) : null}
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
        工作目录：{dependencyRecovery.recommendedCwd}
      </Typography.Paragraph>
    </div>
  )
}
