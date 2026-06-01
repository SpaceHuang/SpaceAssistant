import { shell } from 'electron'

export function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export async function openExternalLink(url: string): Promise<void> {
  if (!isAllowedExternalUrl(url)) {
    throw new Error('invalid external url')
  }
  await shell.openExternal(url)
}
