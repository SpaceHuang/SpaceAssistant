import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolveSafeWorkDirPath } from '../pathSecurity'

const APPROVAL_HASH_MAX = 512 * 1024 * 1024

/** Recheck an attachment from a persisted approval before a deferred IM host is rebuilt. */
export async function verifyDeferredWeChatAttachment(workDir: string, pathInput: string, expectedSha256: string): Promise<{ path: string; sha256: string } | null> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) return null
  try {
    const resolvedPath = await resolveSafeWorkDirPath(workDir, pathInput)
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile() || stat.size > APPROVAL_HASH_MAX) return null
    const hash = createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(resolvedPath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.once('error', reject)
      stream.once('end', resolve)
    })
    const actual = hash.digest('hex')
    return actual === expectedSha256 ? { path: resolvedPath, sha256: actual } : null
  } catch {
    return null
  }
}
