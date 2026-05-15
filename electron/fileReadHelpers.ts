import fs from 'fs/promises'
import path from 'path'
import {
  MAX_FILE_READ_SIZE,
  getFileExtension,
  getImageMimeType,
  isUnsupportedExtension,
  isTextLikeExtension
} from '../src/shared/fileTypes'
import type { FileMetadata, FileReadResult } from '../src/shared/api'

export async function readFileForViewer(absPath: string): Promise<FileReadResult> {
  const st = await fs.stat(absPath)
  if (st.size > MAX_FILE_READ_SIZE) {
    return { kind: 'too_large', size: st.size }
  }

  const ext = getFileExtension(absPath)
  if (isUnsupportedExtension(ext)) {
    return { kind: 'unsupported', ext }
  }

  const mimeType = getImageMimeType(ext)
  if (mimeType) {
    const buf = await fs.readFile(absPath)
    return {
      kind: 'image',
      content: buf.toString('base64'),
      encoding: 'base64',
      mimeType
    }
  }

  try {
    const content = await fs.readFile(absPath, 'utf8')
    return { kind: 'text', content, encoding: 'utf8' }
  } catch {
    if (!isTextLikeExtension(ext)) {
      return { kind: 'unsupported', ext: ext || '(none)' }
    }
    throw new Error('无法读取文件内容')
  }
}

export async function getFileMetadata(absPath: string): Promise<FileMetadata> {
  const st = await fs.stat(absPath)
  const ext = getFileExtension(absPath)
  return {
    size: st.size,
    mtime: st.mtimeMs,
    isText: isTextLikeExtension(ext)
  }
}

export function defaultPdfSavePath(absPath: string): string {
  const parsed = path.parse(absPath)
  return path.join(parsed.dir, `${parsed.name}.pdf`)
}
