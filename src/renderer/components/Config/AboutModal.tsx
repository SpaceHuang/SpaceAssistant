import { ExternalLink, X } from 'lucide-react'
import { App, Button, Modal } from 'antd'
import chatFillRaw from '../../assets/chat_3_fill.svg?raw'
import {
  APP_DESCRIPTION,
  APP_GITHUB_URL,
  APP_LICENSE,
  APP_PRODUCT_NAME,
  APP_TAGLINE,
  APP_VERSION
} from '../../../shared/appMeta'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { openExternalUrl } from '../../services/openExternalUrl'
import { setAboutOpen } from '../../store/configSlice'
import './aboutModal.css'

const appMarkSvg = chatFillRaw.replace(/fill="#09244[bB]"/g, 'fill="currentColor"')

const ABOUT_LINKS = [
  { label: 'GitHub 仓库', url: APP_GITHUB_URL },
  { label: '使用文档', url: APP_GITHUB_URL }
] as const

export function AboutModal() {
  const { message } = App.useApp()
  const open = useTypedSelector((s) => s.config.aboutOpen)
  const dispatch = useAppDispatch()

  const close = () => dispatch(setAboutOpen(false))

  const handleExternalLink = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault()
    void (async () => {
      const result = await openExternalUrl(url)
      if (!result.ok) {
        message.error(result.error || '无法打开链接')
      }
    })()
  }

  return (
    <Modal
      className="about-modal"
      title="关于"
      open={open}
      width={380}
      centered
      destroyOnHidden
      closeIcon={<X size={16} strokeWidth={2} aria-hidden />}
      footer={
        <div className="about-modal__footer">
          <Button type="primary" onClick={close}>
            关闭
          </Button>
        </div>
      }
      onCancel={close}
    >
      <div className="about-modal__body">
        <div className="about-modal__identity">
          <div className="about-modal__mark" aria-hidden dangerouslySetInnerHTML={{ __html: appMarkSvg }} />
          <h2 className="about-modal__name">{APP_PRODUCT_NAME}</h2>
          <p className="about-modal__version">版本 {APP_VERSION}</p>
        </div>

        <p className="about-modal__intro">
          {APP_TAGLINE}。{APP_DESCRIPTION}
        </p>

        <div className="about-modal__actions">
          {ABOUT_LINKS.map((item, index) => (
            <span key={item.label} className="about-modal__action-item">
              {index > 0 ? <span className="about-modal__action-sep" aria-hidden="true" /> : null}
              <a
                href={item.url}
                className="about-modal__link"
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => handleExternalLink(event, item.url)}
              >
                {item.label}
                <ExternalLink size={13} strokeWidth={2} aria-hidden />
              </a>
            </span>
          ))}
        </div>

        <p className="about-modal__license">{APP_LICENSE} License</p>
      </div>
    </Modal>
  )
}
