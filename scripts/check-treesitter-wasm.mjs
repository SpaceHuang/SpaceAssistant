#!/usr/bin/env node
// P0-T2：校验 resources/tree-sitter/ 下受控资产与 SHA256SUMS.txt 一致。
// 任何受控文件缺失、被篡改或清单损坏都以非零码退出（CI test job 挂载）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'resources', 'tree-sitter')
const sumsPath = path.join(dir, 'SHA256SUMS.txt')

const CONTROLLED_FILES = [
  'web-tree-sitter.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-bash.wasm',
  'tree-sitter-powershell.wasm',
  'python-node-types.json',
  'bash-node-types.json',
  'powershell-node-types.json'
]

function fail(message) {
  console.error(`[check-treesitter-wasm] FAIL: ${message}`)
  process.exit(1)
}

function main() {
  if (!fs.existsSync(sumsPath)) fail(`清单缺失: ${sumsPath}`)
  const entries = new Map()
  for (const rawLine of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line)
    if (!match) fail(`清单行格式非法: ${rawLine}`)
    entries.set(match[2], match[1])
  }

  for (const file of CONTROLLED_FILES) {
    if (!entries.has(file)) fail(`清单缺少受控文件: ${file}`)
    const fullPath = path.join(dir, file)
    if (!fs.existsSync(fullPath)) fail(`受控文件缺失: ${file}`)
    const actual = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex')
    if (actual !== entries.get(file)) {
      fail(`哈希不一致: ${file} 期望 ${entries.get(file)} 实际 ${actual}（清单或文件被篡改？vendor 后必须重新生成清单并走评审）`)
    }
  }

  // 清单里不允许出现受控清单之外的条目（防止清单与实际管控面漂移）
  for (const name of entries.keys()) {
    if (!CONTROLLED_FILES.includes(name)) fail(`清单含未知条目: ${name}`)
  }

  console.log(`[check-treesitter-wasm] PASS: ${CONTROLLED_FILES.length} 个受控文件哈希全部一致`)
}

main()
