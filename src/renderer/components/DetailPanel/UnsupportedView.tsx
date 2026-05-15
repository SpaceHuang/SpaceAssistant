import { Typography } from 'antd'
import fileLineRaw from '../../assets/file_line.svg?raw'

const fileSvg = fileLineRaw.replace(/fill="#09244B"/g, 'fill="currentColor"')

type Props = {
  ext?: string | null
  message?: string
}

export function UnsupportedView({ ext, message: msg }: Props) {
  return (
    <div className="detail-unsupported-view">
      <div className="detail-unsupported-icon" dangerouslySetInnerHTML={{ __html: fileSvg }} />
      <Typography.Text type="secondary">
        {msg ?? (ext ? `暂不支持预览 ${ext} 文件` : '暂不支持预览此文件类型')}
      </Typography.Text>
    </div>
  )
}
