import { shell } from 'electron'
import type { LarkCliRunner } from './larkCliRunner'

const URL_RE = /https?:\/\/[^\s)\]"'<>]+/

export function extractHttpUrl(text: string): string | undefined {
  const m = text.match(URL_RE)
  if (!m) return undefined
  return m[0].replace(/[.,;]+$/, '')
}

export type FeishuCliBrowserFlowResult = {
  success: boolean
  stdout: string
  stderr: string
  timedOut: boolean
  authUrl?: string
}

/** 运行 lark-cli 子命令；从 stdout/stderr 流式提取 URL 并打开浏览器（config init / auth login）。 */
export async function runFeishuCliWithBrowserFlow(
  runner: LarkCliRunner,
  args: string[],
  options?: { timeoutSec?: number; onProgress?: (line: string) => void }
): Promise<FeishuCliBrowserFlowResult> {
  let openedUrl: string | undefined

  const handleChunk = (chunk: string) => {
    const line = chunk.trim()
    if (line) options?.onProgress?.(line.slice(-300))
    const url = extractHttpUrl(chunk)
    if (url && !openedUrl) {
      openedUrl = url
      void shell.openExternal(url)
    }
  }

  const r = await runner.run({
    args,
    timeoutSec: options?.timeoutSec ?? 600,
    onStdout: handleChunk,
    onStderr: handleChunk
  })

  return {
    success: r.exitCode === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
    authUrl: openedUrl ?? extractHttpUrl(r.stdout + r.stderr)
  }
}
