export type OpenExternalResult = { ok: true } | { ok: false; error: string }

export async function openExternalUrl(url: string): Promise<OpenExternalResult> {
  if (typeof window.api?.appOpenExternal === 'function') {
    try {
      return await window.api.appOpenExternal(url)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }

  try {
    window.open(url, '_blank', 'noopener,noreferrer')
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}
