const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName
  if (platform === 'win32') {
    return patchWindowsIcon(context)
  }
  if (platform === 'darwin') {
    return adHocSignMacApp(context)
  }
}

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
