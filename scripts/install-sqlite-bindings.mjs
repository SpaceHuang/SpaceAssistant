/**
 * Install Node + Electron prebuilt better-sqlite3 binaries side by side.
 * Electron and Node cannot share one .node (different NODE_MODULE_VERSION).
 */
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const sqliteVersion = pkg.dependencies['better-sqlite3'].replace(/^\^/, '')
const sqliteDir = path.join(root, 'node_modules/better-sqlite3')
const releaseDir = path.join(sqliteDir, 'build/Release')

const electronPkg = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')
)
const electronVersion = electronPkg.version

/** Electron 33.x → NODE_MODULE_VERSION 130 */
function electronModuleAbi(major) {
  if (major >= 33) return 130
  if (major >= 32) return 128
  if (major >= 31) return 125
  throw new Error(`Unsupported Electron major ${major}; extend electronModuleAbi()`)
}

const electronMajor = parseInt(electronVersion.split('.')[0] ?? '10', 10)
const electronAbi = electronModuleAbi(electronMajor)

function prebuildArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

/** better-sqlite3 release tarball platform tag, e.g. win32-x64 / darwin-arm64 */
function prebuildPlatformTag() {
  const arch = prebuildArch()
  if (process.platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  if (process.platform === 'win32') {
    return arch === 'arm64' ? 'win32-arm64' : 'win32-x64'
  }
  if (process.platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  }
  throw new Error(`Unsupported platform ${process.platform}`)
}

if (!fs.existsSync(sqliteDir)) {
  console.warn('[install-sqlite-bindings] better-sqlite3 missing, skip')
  process.exit(0)
}

fs.mkdirSync(releaseDir, { recursive: true })

function copy(src, name) {
  const dest = path.join(releaseDir, name)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.rmSync(dest, { force: true })
  fs.writeFileSync(dest, fs.readFileSync(src))
  console.log(`[install-sqlite-bindings] wrote ${name}`)
}

function stageBuiltNode(runtime) {
  const built = path.join(releaseDir, 'better_sqlite3.node')
  if (!fs.existsSync(built)) {
    throw new Error(`prebuild-install did not produce ${built}`)
  }
  const staged = path.join(releaseDir, `.staged-${runtime}.node`)
  fs.writeFileSync(staged, fs.readFileSync(built))
  return staged
}

function runPrebuild(runtime, target) {
  execSync(
    `npx --yes prebuild-install --runtime ${runtime} --target ${target} --arch ${prebuildArch()}`,
    {
      cwd: sqliteDir,
      stdio: 'inherit'
    }
  )
  return stageBuiltNode(runtime)
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
      console.warn(`[install-sqlite-bindings] download attempt ${i + 1}/${retries} failed, retry in ${waitMs}ms`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  throw lastErr
}

async function installElectronPrebuild() {
  const platform = prebuildPlatformTag()
  const file = `better-sqlite3-v${sqliteVersion}-electron-v${electronAbi}-${platform}.tar.gz`
  const github = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/${file}`
  const urls = [
    github,
    `https://gh-proxy.com/${github}`,
    `https://mirror.ghproxy.com/${github}`
  ]
  const tgz = path.join(releaseDir, 'electron-prebuild.tar.gz')

  let lastErr
  for (const url of urls) {
    try {
      console.log(`[install-sqlite-bindings] downloading ${url}`)
      await downloadWithRetry(url, tgz, 3)
      lastErr = undefined
      break
    } catch (err) {
      lastErr = err
      console.warn(`[install-sqlite-bindings] mirror failed: ${url}`)
    }
  }
  if (lastErr) throw lastErr

  const tmpExtract = path.join(releaseDir, '.tmp-electron')
  fs.rmSync(tmpExtract, { recursive: true, force: true })
  fs.mkdirSync(tmpExtract, { recursive: true })
  execSync(`tar -xf "${tgz}" -C "${tmpExtract}"`, { stdio: 'inherit' })
  fs.unlinkSync(tgz)

  const built = path.join(tmpExtract, 'build/Release/better_sqlite3.node')
  if (!fs.existsSync(built)) {
    fs.rmSync(tmpExtract, { recursive: true, force: true })
    throw new Error(`electron prebuild missing after extract: ${built}`)
  }
  const staged = path.join(releaseDir, '.electron-download.node')
  fs.copyFileSync(built, staged)
  fs.rmSync(tmpExtract, { recursive: true, force: true })
  return staged
}

async function main() {
  console.log(
    `[install-sqlite-bindings] better-sqlite3@${sqliteVersion}, electron@${electronVersion} (abi ${electronAbi}), node@${process.version}, platform=${prebuildPlatformTag()}`
  )

  const nodeBuilt = runPrebuild('node', process.version.replace(/^v/, ''))
  copy(nodeBuilt, 'node/better_sqlite3.node')

  let electronBuilt
  try {
    electronBuilt = runPrebuild('electron', electronVersion)
  } catch {
    console.warn('[install-sqlite-bindings] prebuild-install electron failed, trying direct download...')
    electronBuilt = await installElectronPrebuild()
  }

  copy(electronBuilt, 'electron/better_sqlite3.node')
  copy(electronBuilt, 'better_sqlite3.node')

  for (const legacy of ['better_sqlite3.node-node', 'better_sqlite3.node-electron']) {
    fs.rmSync(path.join(releaseDir, legacy), { force: true })
  }
  for (const staged of ['.staged-node.node', '.staged-electron.node']) {
    fs.rmSync(path.join(releaseDir, staged), { force: true })
  }
  console.log('[install-sqlite-bindings] done')
}

main().catch((err) => {
  console.error('[install-sqlite-bindings] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
