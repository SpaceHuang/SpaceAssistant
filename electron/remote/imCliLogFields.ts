export const IM_CLI_PREVIEW_MAX = 4 * 1024

export function contentHash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return Math.abs(h).toString(16).padStart(8, '0').slice(0, 8)
}

export function previewText(text: string, maxLen = IM_CLI_PREVIEW_MAX): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen)
}

/** Redact URL to origin + pathname (auth URLs, QR URLs, etc.). */
export function urlHostOnly(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return undefined
  }
}
