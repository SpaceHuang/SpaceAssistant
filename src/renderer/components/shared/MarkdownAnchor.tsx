import type { ComponentProps, RefObject } from 'react'
import { resolveMarkdownHrefTarget } from '../../../shared/markdownLinkResolve'
import { scrollToMarkdownFragment } from '../../utils/markdownFragmentScroll'

type AnchorProps = ComponentProps<'a'>

type Props = AnchorProps & {
  wikiRootPath?: string
  baseRelPath?: string | null
  scrollContainerRef?: RefObject<HTMLElement | null>
  onOpenFile?: (relPath: string, fragment?: string) => void
}

export function MarkdownAnchor({
  href,
  children,
  wikiRootPath = 'llm-wiki',
  baseRelPath,
  scrollContainerRef,
  onOpenFile,
  ...rest
}: Props) {
  const target = href ? resolveMarkdownHrefTarget(href, baseRelPath, { wikiRootPath }) : null

  if (target?.kind === 'fragment' && scrollContainerRef) {
    return (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault()
          scrollToMarkdownFragment(target.fragment, scrollContainerRef.current)
        }}
      >
        {children}
      </a>
    )
  }

  if (target?.kind === 'file' && onOpenFile) {
    return (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault()
          onOpenFile(target.relPath, target.fragment)
        }}
      >
        {children}
      </a>
    )
  }

  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}
