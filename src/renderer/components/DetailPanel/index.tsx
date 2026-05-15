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
        <Typography.Text type="secondary">选择文件以预览内容</Typography.Text>
      </div>
    )
  }

  return <FileOverlay />
}
