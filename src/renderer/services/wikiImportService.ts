import { canCollectToWiki } from '../../shared/wikiImportPaths'

export type WikiImportRawResult =
  | { ok: true; rawRelPath: string; copied: boolean }
  | { ok: false; error: string }

export function canShowCollectToWiki(
  relPath: string,
  wikiRootPath: string,
  isDirectory: boolean,
  wikiEnabled: boolean
): boolean {
  return wikiEnabled && canCollectToWiki(relPath, wikiRootPath, isDirectory)
}

export async function importRawToWiki(srcRelPath: string): Promise<WikiImportRawResult> {
  return window.api.wikiImportRaw({ srcRelPath })
}

export function formatCollectToWikiToast(result: Extract<WikiImportRawResult, { ok: true }>): string {
  return result.copied
    ? `已导入 raw：${result.rawRelPath}，Ingest 已开始`
    : `Ingest 已开始：${result.rawRelPath}`
}

export function triggerWikiIngest(rawRelPath: string): void {
  window.dispatchEvent(new CustomEvent('sa-wiki-ingest-request', { detail: { rawRelPath } }))
}

export async function collectToWiki(
  srcRelPath: string,
  options: {
    wikiEnabled: boolean
    sessionId: string | null
    onMissingSession?: () => void
    onError?: (message: string) => void
    onSuccess?: (message: string) => void
  }
): Promise<WikiImportRawResult | null> {
  if (!options.wikiEnabled) {
    options.onError?.('请先在设置中启用 Wiki')
    return null
  }
  if (!options.sessionId) {
    options.onMissingSession?.()
    return null
  }

  const status = await window.api.wikiStatus()
  if (!status.initialized) {
    options.onError?.('Wiki 尚未初始化，请先在设置或 Wiki 分段中初始化')
    return null
  }

  const result = await importRawToWiki(srcRelPath)
  if (!result.ok) {
    options.onError?.(result.error)
    return result
  }

  options.onSuccess?.(formatCollectToWikiToast(result))
  triggerWikiIngest(result.rawRelPath)
  return result
}
