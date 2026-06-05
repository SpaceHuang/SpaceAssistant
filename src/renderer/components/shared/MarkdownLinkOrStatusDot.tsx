import type { ComponentProps, RefObject } from 'react'
import {
  isMarkdownStatusDotHref,
  toneFromMarkdownStatusDotHref
} from '../../../shared/markdownSemanticStatusEmoji'
import { MarkdownAnchor } from './MarkdownAnchor'

type AnchorProps = ComponentProps<'a'>

type Props = AnchorProps & {
  wikiRootPath?: string
  baseRelPath?: string | null
  scrollContainerRef?: RefObject<HTMLElement | null>
  onOpenFile?: (relPath: string, fragment?: string) => void
}

export function MarkdownLinkOrStatusDot({
  href,
  children,
  wikiRootPath,
  baseRelPath,
  scrollContainerRef,
  onOpenFile,
  ...rest
}: Props) {
  if (isMarkdownStatusDotHref(href)) {
    const tone = toneFromMarkdownStatusDotHref(href)
    return <span className={`sa-md-status-dot sa-md-status-dot--${tone}`} role="img" aria-hidden />
  }

  return (
    <MarkdownAnchor
      {...rest}
      href={href}
      wikiRootPath={wikiRootPath}
      baseRelPath={baseRelPath}
      scrollContainerRef={scrollContainerRef}
      onOpenFile={onOpenFile}
    >
      {children}
    </MarkdownAnchor>
  )
}
