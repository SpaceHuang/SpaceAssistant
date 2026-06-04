import path from 'path'
import { pathToFileURL } from 'url'

export function buildLocalFileViewerUrl(absPath: string): string {
  return pathToFileURL(path.resolve(absPath)).href
}
