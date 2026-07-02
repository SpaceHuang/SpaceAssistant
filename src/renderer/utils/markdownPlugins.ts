import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeExternalLinks from 'rehype-external-links'
import rehypeKatex from 'rehype-katex'
import { remarkSemanticStatusEmoji } from '../../shared/markdownSemanticStatusEmoji'
import 'katex/dist/katex.min.css'

/** 聊天与文件 Markdown 渲染共用的 remark 插件链 */
export const markdownRemarkPlugins = [remarkGfm, remarkSemanticStatusEmoji, remarkMath]

/** 聊天与文件 Markdown 渲染共用的 rehype 插件链 */
export const markdownRehypePlugins = [
  [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
  rehypeKatex
]
