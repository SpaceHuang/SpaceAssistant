const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

export function isHtmlExtension(ext: string): boolean {
  return ext === '.html' || ext === '.htm' || ext === '.xhtml'
}

export function isHtmlFile(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  const idx = base.lastIndexOf('.')
  if (idx <= 0) return false
  return isHtmlExtension(base.slice(idx).toLowerCase())
}

export function normalizeViewerUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let candidate = trimmed
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = `https://${candidate}`
  }

  try {
    const parsed = new URL(candidate)
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null
    return parsed.href
  } catch {
    return null
  }
}
