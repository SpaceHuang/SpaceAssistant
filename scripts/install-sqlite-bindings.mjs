/**
 * Install Node + Electron prebuilt better-sqlite3 binaries side by side.
 * Electron bindings come ONLY from scripts/native-bindings-manifest.json
 * (official GitHub Release URL + SHA-256). No third-party mirrors, no npx.
 * Node bindings are built from the locked local source tree.
 */
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const sqliteVersion = pkg.dependencies['better-sqlite3'].replace(/^\^/, '')
const sqliteDir = path.join(root, 'node_modules/better-sqlite3')
const releaseDir = path.join(sqliteDir, 'build/Release')
const manifestPath = path.join(root, 'scripts/native-bindings-manifest.json')

const electronPkg = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')
)
const electronVersion = electronPkg.version

const nodeAbi = require('node-abi')
const electronAbi = Number(nodeAbi.getAbi(electronVersion, 'electron'))

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

function assertManifestMatch() {
  if (manifest.betterSqlite3Version !== sqliteVersion) {
    throw new Error(
      `manifest betterSqlite3Version ${manifest.betterSqlite3Version} != package ${sqliteVersion}`
    )
  }
  if (Number(manifest.electronAbi) !== electronAbi) {
    throw new Error(
      `manifest electronAbi ${manifest.electronAbi} != resolved ABI ${electronAbi} for Electron ${electronVersion}`
    )
  }
}

function prebuildArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

function targetArches() {
  if (process.platform === 'darwin') return ['x64', 'arm64']
  return [prebuildArch()]
}

if (!fs.existsSync(sqliteDir)) {
  console.error('[install-sqlite-bindings] better-sqlite3 missing')
  process.exit(1)
}

fs.mkdirSync(releaseDir, { recursive: true })

function copy(src, name) {
  const dest = path.join(releaseDir, name)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.rmSync(dest, { force: true })
  fs.writeFileSync(dest, fs.readFileSync(src))
  console.log(`[install-sqlite-bindings] wrote ${name}`)
}

function sha256File(filePath) {
  const h = createHash('sha256')
  h.update(fs.readFileSync(filePath))
  return h.digest('hex')
}

function findManifestEntry(arch) {
  const entry = manifest.bindings.find(
    (b) => b.platform === process.platform && b.arch === arch
  )
  if (!entry) {
    throw new Error(
      `No manifest entry for ${process.platform}/${arch} (Electron ABI ${electronAbi}, better-sqlite3 ${sqliteVersion})`
    )
  }
  return entry
}

async function downloadWithRetry(url, dest, retries = 5) {
  let lastErr
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      const buf = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(dest, buf)
      return
    } catch (err) {
      lastErr = err
      const waitMs = 2000 * (i + 1)
      console.warn(
        `[install-sqlite-bindings] download attempt ${i + 1}/${retries} failed, retry in ${waitMs}ms`
      )
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  throw lastErr
}

async function installElectronFromManifest(arch) {
  const entry = findManifestEntry(arch)
  const tgz = path.join(releaseDir, `electron-prebuild-${arch}.tar.gz`)
  console.log(`[install-sqlite-bindings] downloading ${entry.url}`)
  await downloadWithRetry(entry.url, tgz, 5)
  const actual = sha256File(tgz)
  if (actual !== entry.sha256) {
    fs.unlinkSync(tgz)
    throw new Error(
      `SHA-256 mismatch for ${process.platform}/${arch}: expected ${entry.sha256}, got ${actual}`
    )
  }
  const tmpExtract = path.join(releaseDir, `.tmp-electron-${arch}`)
  fs.rmSync(tmpExtract, { recursive: true, force: true })
  fs.mkdirSync(tmpExtract, { recursive: true })
  execSync(`tar -xf "${tgz}" -C "${tmpExtract}"`, { stdio: 'inherit' })
  fs.unlinkSync(tgz)

  const built = path.join(tmpExtract, 'build/Release/better_sqlite3.node')
  if (!fs.existsSync(built)) {
    fs.rmSync(tmpExtract, { recursive: true, force: true })
    throw new Error(`electron prebuild missing after extract: ${built}`)
  }
  const staged = path.join(releaseDir, `.electron-download-${arch}.node`)
  fs.copyFileSync(built, staged)
  fs.rmSync(tmpExtract, { recursive: true, force: true })
  return staged
}

function buildNodeBinding(arch) {
  // Locked local source build — no npx / no remote prebuild for Node.
  // 直接调用 devDependencies 中锁定的 node-gyp（>= 12.1.0 支持 VS 2026），
  // 不经过 npm rebuild：npm 12+ 会因未知 CLI 参数（--build-from-source 等）报 EUNKNOWNCONFIG。
  console.log(`[install-sqlite-bindings] building Node binding from source (arch=${arch})`)
  const nodeGypBin = require.resolve('node-gyp/bin/node-gyp.js')
  execSync(`"${process.execPath}" "${nodeGypBin}" rebuild --release --arch=${arch}`, {
    cwd: sqliteDir,
    stdio: 'inherit'
  })
  const built = path.join(releaseDir, 'better_sqlite3.node')
  if (!fs.existsSync(built)) {
    throw new Error(`Node source build did not produce ${built}`)
  }
  const staged = path.join(releaseDir, `.staged-node-${arch}.node`)
  fs.copyFileSync(built, staged)
  return staged
}

async function main() {
  assertManifestMatch()
  const hostArch = prebuildArch()
  const arches = targetArches()
  console.log(
    `[install-sqlite-bindings] better-sqlite3@${sqliteVersion}, electron@${electronVersion} (abi ${electronAbi}), node@${process.version}, host=${hostArch}, arches=[${arches.join(',')}]`
  )

  const nodeBuilt = buildNodeBinding(hostArch)
  copy(nodeBuilt, `node/better_sqlite3.${hostArch}.node`)
  copy(nodeBuilt, 'node/better_sqlite3.node')

  for (const arch of arches) {
    const electronBuilt = await installElectronFromManifest(arch)
    copy(electronBuilt, `electron/better_sqlite3.${arch}.node`)
    if (arch === hostArch) {
      copy(electronBuilt, 'electron/better_sqlite3.node')
      copy(electronBuilt, 'better_sqlite3.node')
    }
  }

  for (const legacy of ['better_sqlite3.node-node', 'better_sqlite3.node-electron']) {
    fs.rmSync(path.join(releaseDir, legacy), { force: true })
  }
  console.log('[install-sqlite-bindings] done')
}

main().catch((err) => {
  console.error('[install-sqlite-bindings] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
