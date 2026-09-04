import path from 'node:path'

const SUPPORTED = new Set(['darwin-x64', 'darwin-arm64', 'win32-x64'])
const SHA256 = /^[0-9a-f]{64}$/

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string' || !manifest.version || manifest.version === 'latest') throw new Error('ripgrep manifest version must be exact')
  if (!manifest.targets || typeof manifest.targets !== 'object') throw new Error('ripgrep manifest targets are required')
  for (const [key, target] of Object.entries(manifest.targets)) {
    if (!SUPPORTED.has(key)) throw new Error(`unsupported ripgrep target: ${key}`)
    const url = new URL(target.url)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.includes('/BurntSushi/ripgrep/releases/download/')) throw new Error(`untrusted ripgrep URL: ${target.url}`)
    if (!SHA256.test(target.archiveSha256) || !SHA256.test(target.binarySha256)) throw new Error(`invalid SHA-256 for ${key}`)
    if (typeof target.binaryPath !== 'string' || path.posix.isAbsolute(target.binaryPath) || target.binaryPath.split('/').includes('..')) throw new Error(`unsafe archive path for ${key}`)
    if (!['tar.gz', 'zip'].includes(target.archiveType)) throw new Error(`unsupported archive type for ${key}`)
  }
  return manifest
}

export async function assertSha256(buffer, expected, label) {
  const actual = (await import('node:crypto')).createHash('sha256').update(buffer).digest('hex')
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`)
  return actual
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs/promises')
  validateManifest(JSON.parse(await fs.readFile(new URL('./ripgrep-manifest.json', import.meta.url), 'utf8')))
  console.log('ripgrep manifest ok')
}
