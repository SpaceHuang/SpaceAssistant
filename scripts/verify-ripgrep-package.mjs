import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import manifest from './ripgrep-manifest.json' with { type: 'json' }
import { validateManifest } from './ripgrep-manifest.mjs'
import { detectBinaryArch } from './ripgrep-binary-format.mjs'

function sha256(data) { return createHash('sha256').update(data).digest('hex') }

export async function verifyPackage({ packageDir, targetKey: requestedTargetKey }) {
  validateManifest(manifest)
  const isDarwin = await fs.access(path.join(packageDir, 'Contents')).then(() => true).catch(() => false)
  const file = isDarwin
    ? path.join(packageDir, 'Contents', 'Resources', 'bin', 'rg')
    : path.join(packageDir, 'resources', 'bin', 'rg.exe')
  const detectedArch = detectBinaryArch(await fs.readFile(file), isDarwin ? 'darwin' : 'win32')
  const targetKey = requestedTargetKey ?? `${isDarwin ? 'darwin' : 'win32'}-${detectedArch ?? 'unknown'}`
  const target = manifest.targets[targetKey]
  if (!target) throw new Error(`unsupported ripgrep target: ${targetKey}`)
  if (file.includes(`${path.sep}app.asar${path.sep}`)) throw new Error('ripgrep must be outside app.asar')
  const stat = await fs.stat(file)
  if (targetKey.startsWith('darwin-') && (stat.mode & 0o111) === 0) throw new Error(`ripgrep is not executable: ${file}`)
  const digest = sha256(await fs.readFile(file))
  if (digest !== target.binarySha256) throw new Error(`packaged ripgrep SHA-256 mismatch for ${targetKey}`)
  const expectedArch = targetKey.split('-')[1]
  const actualArch = detectedArch
  if (actualArch !== expectedArch) throw new Error(`packaged ripgrep architecture mismatch for ${targetKey}: ${actualArch ?? 'unknown'}`)
  const licenseDir = targetKey.startsWith('darwin-')
    ? path.join(packageDir, 'Contents', 'Resources', 'licenses', 'ripgrep')
    : path.join(packageDir, 'resources', 'licenses', 'ripgrep')
  for (const license of ['COPYING', 'UNLICENSE', 'LICENSE-MIT']) {
    await fs.access(path.join(licenseDir, license))
  }
  const hostKey = `${process.platform}-${process.arch}`
  if (hostKey === targetKey) {
    const versionOutput = execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (!versionOutput.startsWith(`ripgrep ${manifest.version} `)) throw new Error(`packaged ripgrep version mismatch for ${targetKey}`)
  }
  return { packageDir, targetKey, binarySha256: digest }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const packageDir = process.argv[2]
  const targetKey = process.argv[3]
  if (!packageDir) throw new Error('usage: node verify-ripgrep-package.mjs <package-dir> [target-key]')
  console.log(JSON.stringify(await verifyPackage({ packageDir: path.resolve(packageDir), targetKey })))
}
