const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const crypto = require('crypto')

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName
  if (platform === 'win32' || platform === 'darwin') copyBundledRipgrep(context)
  if (platform === 'win32') {
    return patchWindowsIcon(context)
  }
  if (platform === 'darwin') {
    return adHocSignMacApp(context)
  }
}

function copyBundledRipgrep(context) {
  const manifest = context.ripgrepManifest || JSON.parse(fs.readFileSync(path.join(context.packager.info.projectDir, 'scripts', 'ripgrep-manifest.json'), 'utf8'))
  const archNames = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
  const arch = typeof context.arch === 'string' ? context.arch : archNames[context.arch]
  const key = `${context.electronPlatformName}-${arch}`
  const target = manifest.targets[key]
  if (!target) throw new Error(`[afterPack] unsupported ripgrep target: ${key}`)
  const sourceName = key.startsWith('win32') ? 'rg.exe' : 'rg'
  const source = path.join(context.ripgrepSourceDir || path.join(context.packager.info.projectDir, 'resources', 'ripgrep'), key, sourceName)
  if (!fs.existsSync(source)) throw new Error(`[afterPack] missing verified ripgrep staging: ${source}`)
  const bytes = fs.readFileSync(source)
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (digest !== target.binarySha256) throw new Error(`[afterPack] ripgrep SHA-256 mismatch for ${key}`)
  const destination = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'bin', sourceName)
    : path.join(context.appOutDir, 'resources', 'bin', sourceName)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, bytes, { mode: 0o755, flag: 'wx' })
  if (context.electronPlatformName === 'darwin') fs.chmodSync(destination, 0o755)
  const copiedDigest = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
  if (copiedDigest !== target.binarySha256) throw new Error(`[afterPack] copied ripgrep SHA-256 mismatch for ${key}`)
  const licenseSource = context.ripgrepLicenseDir || path.join(context.packager.info.projectDir, 'resources', 'licenses', 'ripgrep')
  const licenseDestination = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'licenses', 'ripgrep')
    : path.join(context.appOutDir, 'resources', 'licenses', 'ripgrep')
  for (const license of ['COPYING', 'UNLICENSE', 'LICENSE-MIT']) {
    const sourceLicense = path.join(licenseSource, license)
    if (!fs.existsSync(sourceLicense)) throw new Error(`[afterPack] missing ripgrep license: ${sourceLicense}`)
    fs.mkdirSync(licenseDestination, { recursive: true })
    fs.copyFileSync(sourceLicense, path.join(licenseDestination, license), fs.constants.COPYFILE_EXCL)
  }
  console.log(`[afterPack] bundled ripgrep ${key}: ${destination}`)
}

module.exports.copyBundledRipgrep = copyBundledRipgrep

/**
 * 无 Apple 开发者证书时对 macOS app 做 ad-hoc 签名，使 arm64 可本机启动
 * （从网络下载的包仍需用户执行 xattr -cr 去除隔离）。
 */
function adHocSignMacApp(context) {
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  if (!fs.existsSync(appPath)) {
    throw new Error(`[afterPack] macOS .app not found: ${appPath}`)
  }
  // electron-builder 在 afterPack 之后还会跑 sign 步骤：若存在 Developer ID 会重新签名覆盖 ad-hoc；
  // 若无证书（CI）则跳过，ad-hoc 签名得以保留。CSC_IDENTITY_AUTO_DISCOVERY=false 时必须仍执行。
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  })
  console.log('[afterPack] Ad-hoc signed and verified macOS app:', appPath)
}

function patchWindowsIcon(context) {
  const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit')
  const projectDir = context.packager.info.projectDir
  const iconPath = path.join(projectDir, 'res', 'icons', 'sa-logo.ico')
  const exePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  )

  if (!fs.existsSync(iconPath)) {
    console.warn('[afterPack] Windows app icon not found:', iconPath)
    return
  }
  if (!fs.existsSync(exePath)) {
    console.warn('[afterPack] Executable not found:', exePath)
    return
  }

  const iconFile = Data.IconFile.from(fs.readFileSync(iconPath))
  const icons = iconFile.icons.map((item) => item.data)

  const exe = NtExecutable.from(fs.readFileSync(exePath))
  const res = NtExecutableResource.from(exe)
  const iconGroups = Resource.IconGroupEntry.fromEntries(res.entries)

  if (iconGroups.length === 0) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons)
  } else {
    for (const group of iconGroups) {
      Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        group.id,
        group.lang,
        icons,
      )
    }
  }

  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log('[afterPack] Patched Windows exe icon:', exePath)
}
