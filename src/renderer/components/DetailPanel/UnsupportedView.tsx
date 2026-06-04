import { Typography } from 'antd'
import fileLineRaw from '../../assets/file_line.svg?raw'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

const fileSvg = fileLineRaw.replace(/fill="#09244B"/g, 'fill="currentColor"')

type Props = {
  ext?: string | null
  message?: string
}

export function UnsupportedView({ ext, message: msg }: Props) {
  const { t } = useTypedTranslation('detailPanel')
  return (
    <div className="detail-unsupported-view">
      <div className="detail-unsupported-icon" dangerouslySetInnerHTML={{ __html: fileSvg }} />
      <Typography.Text type="secondary">
        {msg ?? (ext ? t('fileView.unsupportedExt', { ext }) : t('fileView.unsupportedGeneric'))}
      </Typography.Text>
    </div>
  )
}
