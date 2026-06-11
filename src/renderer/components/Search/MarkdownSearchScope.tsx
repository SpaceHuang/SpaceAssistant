import { useRef, type ReactNode } from 'react'
import { FileMarkdownSearchDriver } from './searchDrivers'

/** 搜索驱动与内容分离，内容区不因匹配计数更新而重渲染。 */
export function MarkdownSearchScope({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <FileMarkdownSearchDriver containerRef={containerRef} />
      <div ref={containerRef} className="detail-md-search-root">
        {children}
      </div>
    </>
  )
}
