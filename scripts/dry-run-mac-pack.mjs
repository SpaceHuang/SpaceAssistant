/**
 * macOS pack 配置 dry-run（可在 Windows/Linux 上运行）。
 * 不执行真实 mac 打包，只校验 electron-builder 配置与资源。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'

const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = join(__dirname, '..')

const pkg = require(join(root, 'package.json'))
const errors = []
const warnings = []
const info = []

function ok(msg) {
  info.push(`✓ ${msg}`)
}

function warn(msg) {
  warnings.push(`⚠ ${msg}`)
}

function fail(msg) {
  errors.push(`✗ ${msg}`)
}

function readPngDimensions(filePath) {
  const buf = readFileSync(filePath)
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
    return null
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// 1. mac 配置结构
const mac = pkg.build?.mac
if (!mac) {
  fail('package.json build.mac 缺失')
} else {
  ok('build.mac 存在')
  const targets = Array.isArray(mac.target) ? mac.target : [mac.target]
  const dmgTarget = targets.find(
    (t) => (typeof t === 'object' && t.target === 'dmg') || t === 'dmg',
  )
  if (!dmgTarget) {
    fail('未找到 dmg target 配置')
  } else if (typeof dmgTarget === 'string') {
    warn('dmg target 未显式声明 arch，将使用 runner 默认架构')
  } else {
    const arches = dmgTarget.arch ?? []
    const expected = ['x64', 'arm64']
    ok(`dmg arch 配置: ${arches.join(', ')}`)
    for (const arch of expected) {
      if (!arches.includes(arch)) {
        fail(`缺少 arch: ${arch}`)
      }
    }
    if (arches.includes('universal')) {
      warn('已配置 universal arch；arm64 CI runner 上合并 universal DMG 可能失败，建议仅保留 x64 + arm64')
    }
    if (arches.length !== expected.length) {
      warn(`arch 数量 ${arches.length}，预期 ${expected.length}`)
    }
  }
}

// 2. electron-builder 能否加载配置
try {
  const builderPkg = require('electron-builder/package.json')
  ok(`electron-builder ${builderPkg.version} 已安装`)
} catch {
  fail('electron-builder 未安装')
}

// 3. macOS 图标：须为 1024 PNG 或 .icns（勿用 .iconset，app-builder 不会写入 1024px 层）
const iconRel = mac?.icon ?? ''
const iconPath = iconRel ? join(root, iconRel) : ''

if (!iconRel) {
  fail('mac.icon 未配置')
} else if (!existsSync(iconPath)) {
  fail(`mac.icon 文件不存在: ${iconRel}`)
} else if (iconRel.endsWith('.iconset')) {
  fail(
    'mac.icon 不应指向 .iconset 目录；app-builder 转换后 icns 最高仅 512px，Retina 桌面会锯齿。请改用 res/icons/sa-logo-1024.png 或预生成的 .icns',
  )
} else if (iconRel.endsWith('.icns')) {
  ok(`mac.icon 使用 .icns: ${iconRel}`)
} else if (iconRel.endsWith('.png')) {
  const dims = readPngDimensions(iconPath)
  if (!dims) {
    fail(`mac.icon 不是有效 PNG: ${iconRel}`)
  } else if (dims.width < 1024 || dims.height < 1024) {
    fail(`mac.icon PNG 尺寸 ${dims.width}x${dims.height}，macOS 至少需要 1024x1024`)
  } else if (dims.width !== dims.height) {
    fail(`mac.icon PNG 须为正方形，当前 ${dims.width}x${dims.height}`)
  } else {
    ok(`mac.icon PNG ${dims.width}x${dims.height}: ${iconRel}`)
  }
} else {
  warn(`mac.icon 扩展名未识别: ${iconRel}，预期 .png 或 .icns`)
}

// 4. 用 app-builder 预检 icns 是否含 1024px 层
if (iconRel && existsSync(iconPath) && !iconRel.endsWith('.iconset')) {
  try {
    const appBuilderPkg = require('app-builder-bin')
    const outDir = join(root, 'release', '.icon-icns-dry-run')
    const result = spawnSync(
      appBuilderPkg.appBuilderPath,
      [
        'icon',
        '--format',
        'icns',
        '--root',
        root,
        '--root',
        root,
        '--out',
        outDir,
        '--input',
        iconRel,
      ],
      { encoding: 'utf8', cwd: root },
    )
    const stdout = (result.stdout ?? '').trim()
    if (result.status !== 0) {
      fail(`app-builder icns 转换失败: ${result.stderr || stdout || result.status}`)
    } else {
      const parsed = JSON.parse(stdout)
      const maxSize = parsed.icons?.[0]?.size ?? 0
      if (maxSize < 1024) {
        fail(`app-builder 生成的 icns 最大尺寸仅 ${maxSize}px，Retina 桌面会锯齿`)
      } else {
        ok(`app-builder icns 预检通过（最大 ${maxSize}px）`)
      }
    }
  } catch (err) {
    warn(`无法运行 app-builder icns 预检: ${err instanceof Error ? err.message : err}`)
  }
}

// 5. 构建产物前置条件
for (const dir of ['dist/renderer', 'dist-electron/electron']) {
  if (!existsSync(join(root, dir))) {
    warn(`构建产物缺失: ${dir}（pack:mac 前需先 npm run build）`)
  } else {
    ok(`构建产物存在: ${dir}`)
  }
}

// 6. macOS 双架构原生模块（x64 + arm64 DMG 共用同一 node_modules）
const sqliteElectronDir = join(root, 'node_modules/better-sqlite3/build/Release/electron')
for (const arch of ['x64', 'arm64']) {
  const f = join(sqliteElectronDir, `better_sqlite3.${arch}.node`)
  if (!existsSync(f)) {
    warn(`better-sqlite3 electron 绑定缺失: ${arch}（运行 npm run rebuild:native 后重试）`)
  } else {
    ok(`better-sqlite3 electron 绑定存在: ${arch}`)
  }
}

// 7. 平台限制说明
if (process.platform !== 'darwin') {
  warn(
    `当前系统为 ${process.platform}，无法执行真实 pack:mac（electron-builder 限制）`,
  )
  info.push('→ CI 将在 macos-latest runner 上执行 npm run pack:mac')
  info.push('→ 预期产出 2 个 DMG：SpaceAssistant-*.dmg（Intel）、SpaceAssistant-*-arm64.dmg（Apple Silicon）')
}

console.log('\n=== macOS pack dry-run ===\n')
for (const line of info) console.log(line)
if (warnings.length) {
  console.log('')
  for (const line of warnings) console.log(line)
}
if (errors.length) {
  console.log('')
  for (const line of errors) console.log(line)
  console.log(`\n结果: FAILED (${errors.length} 项错误)\n`)
  process.exit(1)
}

console.log(`\n结果: PASSED${warnings.length ? ` (${warnings.length} 项警告)` : ''}\n`)
