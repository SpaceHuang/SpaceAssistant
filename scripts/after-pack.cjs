const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const crypto = require('crypto')

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName
  const buildIdentity = writeSessionStorageBuildIdentity(context)
  writeSessionStorageCleanupReleaseMetadata(context, buildIdentity)
  if (platform === 'win32' || platform === 'darwin') copyBundledRipgrep(context)
  verifyTreeSitterAssets(context)
  if (platform === 'win32') {
    return patchWindowsIcon(context)
  }
  if (platform === 'darwin') {
    return adHocSignMacApp(context)
  }
}

function writeSessionStorageBuildIdentity(context, runGit = execFileSync) {
  const projectDir = context.packager.info.projectDir
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
  const sourceTreeClean = runGit('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: projectDir,
    encoding: 'utf8',
  }).trim().length === 0
  const commitSha = runGit('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim()
  const resourceDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  fs.mkdirSync(resourceDir, { recursive: true })
  const identity = {
    formatVersion: 2,
    version: packageJson.version,
    commitSha: /^[a-f0-9]{40}$/i.test(commitSha) ? commitSha : null,
    sourceTreeClean,
    buildId: crypto.randomUUID(),
    target: {
      platform: context.electronPlatformName === 'darwin' ? 'mac'
        : context.electronPlatformName === 'win32' ? 'win' : context.electronPlatformName,
      arch: getReleaseTargetKey(context).split('-').at(-1),
    },
  }
  fs.writeFileSync(path.join(resourceDir, 'session-storage-build-identity.json'), `${JSON.stringify(identity, null, 2)}\n`)
  console.log(`[afterPack] 已写入会话存储构建身份（${sourceTreeClean ? '工作树干净' : '工作树有改动'}）`)
  return identity
}

module.exports.writeSessionStorageBuildIdentity = writeSessionStorageBuildIdentity

const CLEANUP_RELEASE_INPUT_FILES = Object.freeze({
  deployment: 'session-storage-cleanup-deployment.json',
  compatibility: 'session-storage-cleanup-compatibility.json',
})

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function readReleaseInputFile(inputDir, fileName) {
  const filePath = path.join(inputDir, fileName)
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`[afterPack] release metadata must be a regular file: ${fileName}`)
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function getReleaseTargetKey(context) {
  const archNames = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
  const arch = typeof context.arch === 'string' ? context.arch : archNames[context.arch]
  const platform = context.electronPlatformName === 'darwin' ? 'mac'
    : context.electronPlatformName === 'win32' ? 'win' : context.electronPlatformName
  return `${platform}-${arch}`
}

/**
 * Inject post-commit rollback metadata from the ignored release-input directory.
 * This keeps the C commit SHA out of its own tracked tree while packaging the
 * exact record into the app's read-only resources. Missing input always writes
 * the default-off configuration.
 */
function writeSessionStorageCleanupReleaseMetadata(context, buildIdentity) {
  const projectDir = context.packager.info.projectDir
  const inputDir = path.join(projectDir, 'release-input')
  const deploymentPath = path.join(inputDir, CLEANUP_RELEASE_INPUT_FILES.deployment)
  const compatibilityPath = path.join(inputDir, CLEANUP_RELEASE_INPUT_FILES.compatibility)
  const deploymentExists = fs.existsSync(deploymentPath)
  const compatibilityExists = fs.existsSync(compatibilityPath)
  if (deploymentExists !== compatibilityExists) {
    throw new Error('[afterPack] release-input must contain both cleanup deployment and compatibility files')
  }

  let deployment = { formatVersion: 1, allowContentCleanup: false, compatibilityRecordSha256: null }
  let compatibility = null
  if (deploymentExists) {
    deployment = readReleaseInputFile(inputDir, CLEANUP_RELEASE_INPUT_FILES.deployment)
    compatibility = readReleaseInputFile(inputDir, CLEANUP_RELEASE_INPUT_FILES.compatibility)
  }

  if (!deployment || deployment.formatVersion !== 1 || typeof deployment.allowContentCleanup !== 'boolean') {
    throw new Error('[afterPack] invalid cleanup deployment release metadata')
  }
  if (deployment.allowContentCleanup) {
    if (!buildIdentity || buildIdentity.sourceTreeClean !== true || !/^[a-f0-9]{40}$/.test(buildIdentity.commitSha || '')) {
      throw new Error('[afterPack] cleanup release metadata requires a clean, fixed source commit')
    }
    if (!compatibility || compatibility.formatVersion !== 1 || compatibility.decision !== 'accepted' ||
      typeof compatibility.review?.reference !== 'string' || !compatibility.review.reference.trim() ||
      typeof compatibility.review?.reviewedAt !== 'string' || !compatibility.review.reviewedAt.trim()) {
      throw new Error('[afterPack] enabled cleanup requires an accepted compatibility record')
    }
    if (compatibility.candidate?.version !== buildIdentity.version ||
      compatibility.candidate?.commitSha !== buildIdentity.commitSha) {
      throw new Error('[afterPack] candidate commit does not match packaged source HEAD')
    }
    const expectedDigest = deployment.compatibilityRecordSha256
    const actualDigest = crypto.createHash('sha256').update(stableJson(compatibility)).digest('hex')
    if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest) || expectedDigest !== actualDigest) {
      throw new Error('[afterPack] cleanup compatibility record digest mismatch')
    }
    const targetKey = getReleaseTargetKey(context)
    const artifact = compatibility.rollback?.artifacts?.[targetKey]
    if (!artifact || typeof artifact.downloadUrl !== 'string' || !artifact.downloadUrl.trim() ||
      typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
      throw new Error(`[afterPack] rollback artifact missing for ${targetKey}`)
    }
  } else if (deployment.compatibilityRecordSha256 !== null || compatibility !== null) {
    throw new Error('[afterPack] disabled cleanup must not bundle an authorization record')
  }

  const resourceDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  fs.mkdirSync(resourceDir, { recursive: true })
  fs.writeFileSync(path.join(resourceDir, CLEANUP_RELEASE_INPUT_FILES.deployment), `${JSON.stringify(deployment, null, 2)}\n`)
  fs.writeFileSync(path.join(resourceDir, CLEANUP_RELEASE_INPUT_FILES.compatibility), `${JSON.stringify(compatibility, null, 2)}\n`)
  console.log(`[afterPack] 已写入会话存储清理发布元数据（${deployment.allowContentCleanup ? '门禁已配置' : '默认关闭'}）`)
}

module.exports.writeSessionStorageCleanupReleaseMetadata = writeSessionStorageCleanupReleaseMetadata

// P0-T6：打包产物内 tree-sitter 受控资产（4 wasm + 3 node-types.json）必须存在
// 且哈希与 resources/tree-sitter/SHA256SUMS.txt 一致，不符即打包失败。
function verifyTreeSitterAssets(context) {
  const projectDir = context.packager.info.projectDir
  const sumsPath = path.join(projectDir, 'resources', 'tree-sitter', 'SHA256SUMS.txt')
  const entries = new Map()
  for (const rawLine of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line)
    if (!match) throw new Error(`[afterPack] malformed SHA256SUMS line: ${rawLine}`)
    entries.set(match[2], match[1])
  }
  const destinationBase = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'tree-sitter')
    : path.join(context.appOutDir, 'resources', 'tree-sitter')
  for (const [name, expected] of entries) {
    const target = path.join(destinationBase, name)
    if (!fs.existsSync(target)) throw new Error(`[afterPack] missing tree-sitter asset in package: ${target}`)
    const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    if (digest !== expected) throw new Error(`[afterPack] tree-sitter asset hash mismatch: ${name}`)
  }
  console.log(`[afterPack] verified ${entries.size} tree-sitter assets in package`)
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
    copyOrVerifyLicense(sourceLicense, path.join(licenseDestination, license), license)
  }
  console.log(`[afterPack] bundled ripgrep ${key}: ${destination}`)
}

module.exports.copyBundledRipgrep = copyBundledRipgrep

function copyOrVerifyLicense(sourceLicense, targetLicense, label) {
  if (!fs.existsSync(targetLicense)) {
    fs.copyFileSync(sourceLicense, targetLicense, fs.constants.COPYFILE_EXCL)
    return
  }
  const sourceStat = fs.statSync(sourceLicense)
  const targetStat = fs.lstatSync(targetLicense)
  if (!targetStat.isFile() || targetStat.isSymbolicLink() || sourceStat.size !== targetStat.size ||
      !crypto.timingSafeEqual(
        crypto.createHash('sha256').update(fs.readFileSync(sourceLicense)).digest(),
        crypto.createHash('sha256').update(fs.readFileSync(targetLicense)).digest(),
      )) {
    throw new Error(`[afterPack] packaged ripgrep license mismatch: ${label}`)
  }
}

module.exports.copyOrVerifyLicense = copyOrVerifyLicense

/**
 * 无 Apple 开发者证书时对 macOS app 做 ad-hoc 签名，使 arm64 可本机启动
 * （从网络下载的包仍需用户执行 xattr -cr 去除隔离）。
 */
async function adHocSignMacApp(
  context,
  runCommand = (command, args) => execFileSync(command, args, { stdio: 'inherit' }),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  const electronFrameworkPath = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
  )
  if (!fs.existsSync(appPath)) {
    throw new Error(`[afterPack] macOS .app not found: ${appPath}`)
  }
  // electron-builder 在 afterPack 之后还会跑 sign 步骤：若存在 Developer ID 会重新签名覆盖 ad-hoc；
  // 若无证书（CI）则跳过，ad-hoc 签名得以保留。CSC_IDENTITY_AUTO_DISCOVERY=false 时必须仍执行。
  // Electron arm64 framework binaries may carry com.apple.provenance from the
  // downloaded build artifact. Remove extended attributes before recursively
  // ad-hoc signing so codesign does not fail while replacing its nested signature.
  let signed = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    runCommand('xattr', ['-cr', appPath])
    // Give macOS time to settle provenance metadata written while electron-builder
    // copies the arm64 framework into the app bundle before codesign replaces it.
    await wait(1000)
    try {
      // Electron's arm64 framework can arrive linker-signed with a bundle
      // resource seal that ad-hoc recursive signing cannot replace in one pass.
      runCommand('codesign', ['--force', '--deep', '--sign', '-', electronFrameworkPath])
      runCommand('codesign', ['--force', '--deep', '--sign', '-', appPath])
      signed = true
      break
    } catch (error) {
      if (attempt === 1) throw error
      console.warn('[afterPack] ad-hoc signing failed once; retrying after clearing extended attributes')
    }
  }
  if (!signed) throw new Error('[afterPack] ad-hoc signing failed')
  runCommand('codesign', ['--verify', '--deep', '--strict', appPath])
  console.log('[afterPack] Ad-hoc signed and verified macOS app:', appPath)
}

module.exports.adHocSignMacApp = adHocSignMacApp

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
