#!/usr/bin/env node
/**
 * SDK 包边界护栏(A3,偏差 19;P1-5 评审强化):等价 ESLint no-restricted-paths 的 CI 断言。
 * 断言 1/2/3 的扫描面统一为「SDK 入口展开出的完整模块闭包」——此前只扫包内 5 文件,
 * 而闭包约 16 个模块在宿主树 src/shared/**,bare 导入可同时绕过两条断言(假绿)。
 * 闭包展开同时匹配单/双引号、副作用 import、require() 与动态 import(P1-5 漏边修复)。
 * 禁止项:闭包内任何文件的 `electron`(bare / 子路径 / 相对逃逸)与 `node:sqlite`。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, 'packages', 'agent-core')
const entry = path.join(pkgDir, 'src', 'index.ts')

// ---- 闭包展开(单/双引号、副作用 import、require()、动态 import)----
const seen = new Set()
function walk(file) {
  const real = (() => {
    try { return statSync(file).isFile() ? file : null } catch { return null }
  })()
  if (!real || seen.has(real)) return
  seen.add(real)
  const src = readFileSync(real, 'utf8')
  const re = /(?:import\s+[^'"()]*?from\s*|import\s*|export\s+[^'"()]*?from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const spec = m[1]
    if (!spec.startsWith('.')) continue
    const target = path.resolve(path.dirname(file), spec)
    for (const ext of ['', '.ts', '.tsx', '/index.ts']) {
      if (existsSync(target + ext) && statSync(target + ext).isFile()) {
        walk(target + ext)
        break
      }
    }
  }
}
walk(entry)

const failures = []

function listFiles(dir, out = []) {
  for (const entryName of readdirSync(dir)) {
    const full = path.join(dir, entryName)
    if (statSync(full).isDirectory()) {
      if (entryName === 'node_modules' || entryName === 'dist') continue
      listFiles(full, out)
    } else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

for (const file of seen) {
  const rel = path.relative(root, file)
  const src = readFileSync(file, 'utf8')
  // 闭包内任何文件:electron bare / 子路径 / 相对逃逸、node:sqlite 一律违规
  if (/(?:import\s+[^'"()]*?from\s*|import\s*|export\s+[^'"()]*?from\s*|require\s*\(\s*|import\s*\(\s*)['"](?:electron|electron\/[^'"]+)['"]/.test(src)) {
    failures.push(`${rel}: 禁止依赖 electron`)
  }
  if (/['"]node:sqlite['"]/.test(src)) {
    failures.push(`${rel}: 禁止依赖 node:sqlite(存储走端口注入)`)
  }
  if (rel.split(path.sep)[0] === 'electron') {
    failures.push(`SDK 入口闭包可达 electron 模块: ${rel}(应为 0)`)
  }
}

if (failures.length > 0) {
  console.error('[check:agent-core] 包边界违规:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`[check:agent-core] OK:SDK 入口闭包 ${seen.size} 个模块,全闭包零 electron / 零 node:sqlite`)
