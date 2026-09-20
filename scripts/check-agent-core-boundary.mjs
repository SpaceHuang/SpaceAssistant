#!/usr/bin/env node
/**
 * SDK 包边界护栏(A3,偏差 19):等价 ESLint no-restricted-paths 的 CI 断言
 * (仓库无 eslint 基础设施,护栏以本脚本落地;三条断言全过即边界成立):
 *  1. packages/agent-core 内不得出现 `from 'electron'` / `require('electron')`
 *  2. packages/agent-core 内不得出现 `node:sqlite`(存储走端口,桌面适配层在宿主侧绑定)
 *  3. 从 SDK 入口(packages/agent-core/src/index.ts)展开相对 import 闭包,可达 electron/ 的模块数 = 0
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, 'packages', 'agent-core')

function listFiles(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      listFiles(full, ext, out)
    } else if (full.endsWith(ext)) out.push(full)
  }
  return out
}

const failures = []

// 断言 1 + 2:包内源码文本扫描
for (const file of listFiles(pkgDir, '.ts')) {
  const src = readFileSync(file, 'utf8')
  const rel = path.relative(root, file)
  if (/from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(src)) {
    failures.push(`${rel}: 禁止依赖 electron`)
  }
  if (src.includes('node:sqlite')) {
    failures.push(`${rel}: 禁止依赖 node:sqlite(存储走端口注入)`)
  }
}

// 断言 3:SDK 入口闭包展开,可达 electron/ = 0
const seen = new Set()
function walk(file) {
  const real = (() => {
    try { return statSync(file).isFile() ? file : null } catch { return null }
  })()
  if (!real || seen.has(real)) return
  seen.add(real)
  const src = readFileSync(real, 'utf8')
  const re = /from\s+'(\.[^']+)'/g
  let m
  while ((m = re.exec(src))) {
    const target = path.resolve(path.dirname(file), m[1])
    for (const ext of ['', '.ts', '.tsx', '/index.ts']) {
      if (existsSync(target + ext) && statSync(target + ext).isFile()) {
        walk(target + ext)
        break
      }
    }
  }
}

const entry = path.join(pkgDir, 'src', 'index.ts')
walk(entry)
for (const file of seen) {
  const rel = path.relative(root, file)
  if (rel.split(path.sep)[0] === 'electron') {
    failures.push(`SDK 入口闭包可达 electron 模块: ${rel}(应为 0)`)
  }
}

if (failures.length > 0) {
  console.error('[check:agent-core] 包边界违规:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`[check:agent-core] OK:包内 ${listFiles(pkgDir, '.ts').length} 个文件零 electron / 零 node:sqlite;入口闭包 ${seen.size} 个模块零 electron`)
