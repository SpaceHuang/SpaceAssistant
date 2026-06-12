/**
 * macOS pack 配置 dry-run（可在 Windows/Linux 上运行）。
 * 不执行真实 mac 打包，只校验 electron-builder 配置与资源。
 */
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

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
    const expected = ['x64', 'arm64', 'universal']
    ok(`dmg arch 配置: ${arches.join(', ')}`)
    for (const arch of expected) {
      if (!arches.includes(arch)) {
        fail(`缺少 arch: ${arch}`)
      }
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

// 3. universal 支持（app-builder-lib）
try {
  const { Arch } = require('builder-util')
  if (Arch.universal == null) {
    fail('builder-util 不支持 Arch.universal')
  } else {
    ok(`builder-util 支持 universal (Arch.universal=${Arch.universal})`)
  }
} catch (e) {
  fail(`无法加载 builder-util Arch: ${e.message}`)
}

// 4. macOS 图标 iconset
const iconRel = mac?.icon ?? ''
const iconsetDir = join(root, iconRel)
const requiredIconset = [
  'icon_16x16.png',
  'icon_16x16@2x.png',
  'icon_32x32.png',
  'icon_32x32@2x.png',
  'icon_128x128.png',
  'icon_128x128@2x.png',
  'icon_256x256.png',
  'icon_256x256@2x.png',
  'icon_512x512.png',
  'icon_512x512@2x.png',
]

if (!iconRel) {
  fail('mac.icon 未配置')
} else if (!existsSync(iconsetDir)) {
  fail(`iconset 目录不存在: ${iconRel}`)
} else {
  const files = new Set(readdirSync(iconsetDir))
  ok(`iconset 目录存在: ${iconRel}`)
  for (const name of requiredIconset) {
    if (!files.has(name)) {
      fail(`iconset 缺少: ${name}`)
    }
  }
  if (requiredIconset.every((n) => files.has(n))) {
    ok('iconset 包含全部 10 个标准 PNG')
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

// 6. 平台限制说明
if (process.platform !== 'darwin') {
  warn(
    `当前系统为 ${process.platform}，无法执行真实 pack:mac（electron-builder 限制）`,
  )
  info.push('→ CI 将在 macos-latest runner 上执行 npm run pack:mac')
  info.push('→ 预期产出 3 个 DMG：*-x64.dmg、*-arm64.dmg、*-universal.dmg')
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
