import fs from 'node:fs/promises'
import { resolveSafePathReal } from '../pathSecurity'

export async function buildConfirmationDiff(
  workDir: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<{ oldContent: string; newContent: string; oldPath: string } | undefined> {
  const rel = typeof input.path === 'string' ? input.path : ''
  if (!rel || (toolName !== 'edit_file' && toolName !== 'write_file')) return undefined
  try {
    const abs = await resolveSafePathReal(workDir, rel)
    let oldContent = ''
    try {
      oldContent = await fs.readFile(abs, 'utf8')
    } catch {
      oldContent = ''
    }
    let newContent = ''
    if (toolName === 'write_file') {
      newContent = typeof input.content === 'string' ? input.content : ''
    } else {
      const oldS = typeof input.old_string === 'string' ? input.old_string : ''
      const newS = typeof input.new_string === 'string' ? input.new_string : ''
      const replaceAll = Boolean(input.replace_all)
      if (oldS === '' && !oldContent) newContent = newS
      else {
        const occurrences = oldS === '' ? 0 : oldContent.split(oldS).length - 1
        if (occurrences === 1 || replaceAll) {
          newContent = replaceAll ? oldContent.split(oldS).join(newS) : oldContent.replace(oldS, newS)
        } else {
          newContent = oldContent
        }
      }
    }
    return { oldContent, newContent, oldPath: rel }
  } catch {
    return undefined
  }
}
