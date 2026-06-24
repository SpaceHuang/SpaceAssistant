import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Dropdown } from 'antd'
import type { MenuProps } from 'antd/es/menu/interface'
import { attachSelectionCopy, getSelectionTextInContainer, writeClipboardText } from '../../utils/selectionCopy'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  registerFileBodyElement: (element: HTMLElement | null) => void
  children: ReactNode
}

export function FileContentBody({ registerFileBodyElement, children }: Props) {
  const copyDisposeRef = useRef<{ dispose: () => void } | null>(null)
  const copyTextRef = useRef('')
  const { t } = useTypedTranslation('detailPanel')

  const mergedRef = useCallback(
    (node: HTMLDivElement | null) => {
      copyDisposeRef.current?.dispose()
      copyDisposeRef.current = null
      registerFileBodyElement(node)
      if (node) {
        copyDisposeRef.current = attachSelectionCopy(node)
      }
    },
    [registerFileBodyElement]
  )

  useEffect(() => () => copyDisposeRef.current?.dispose(), [])

  const handleContextMenuCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const text = getSelectionTextInContainer(event.currentTarget)
    if (!text) {
      event.preventDefault()
      return
    }
    copyTextRef.current = text
  }

  const menuItems: MenuProps['items'] = [
    {
      key: 'copy',
      label: t('fileView.contextMenu.copy'),
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation()
        void writeClipboardText(copyTextRef.current)
      }
    }
  ]

  return (
    <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
      <div className="detail-file-body" ref={mergedRef} onContextMenuCapture={handleContextMenuCapture}>
        {children}
      </div>
    </Dropdown>
  )
}
