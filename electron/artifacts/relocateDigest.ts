import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

/** SHA-256 hex digest of file contents for relocate journal verification. */
export async function computeFileDigest(absPath: string): Promise<string> {
  const data = await fs.readFile(absPath)
  return createHash('sha256').update(data).digest('hex')
}
