import { Typography } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { FileOverlay } from './FileOverlay'
import './detailPanel.css'

export { DetailPanelProvider, useDetailPanel } from './DetailPanelContext'

export function DetailPanel() {
  const { selectedFile } = useDetailPanel()

  if (!selectedFile) {
    return (
      <div className="detail-panel-placeholder">
        <Typography.Text type="secondary">右侧栏预留（功能开发中）</Typography.Text>
      </div>
    )
  }

  return <FileOverlay />
}
