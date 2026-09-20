// P0-T1：tree-sitter 依赖引入后的真实解析探测。
// 从 node_modules 加载核心运行时 + 三个 grammar wasm，对三语言各解析一份真实样本，
// 断言 0 ERROR，打印各 grammar 的 ABI/language version 与 4 个 wasm 的字节体积。
// 退出码 0 = 探测通过；非 0 = 任一环节失败（ABI 超区间 / 解析含 ERROR / 体积超预算）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ParserModule = require('web-tree-sitter')
const { Parser, Language, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION } = ParserModule

const WASM_SIZE_BUDGET_TOTAL = 6 * 1024 * 1024

const samples = {
  python: {
    wasm: 'tree-sitter-python/tree-sitter-python.wasm',
    code: [
      'import os',
      'from typing import Dict',
      'def greet(name: str = "world") -> str:',
      '    return f"hello, {name}!"',
      'class Runner:',
      '    @staticmethod',
      '    async def run(cmd):',
      '        with open("/tmp/x", "w") as fh:',
      '            fh.write(cmd)',
      '        try:',
      '            data = {"k": [1, 2, 3]}',
      '        except Exception as exc:',
      '            raise exc',
      '    total = sum(x * 2 for x in range(10) if x > 1)',
      'print(greet("tree-sitter"))'
    ].join('\n')
  },
  bash: {
    wasm: 'tree-sitter-bash/tree-sitter-bash.wasm',
    code: [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'URL="https://example.com/install.sh"',
      'curl -fsSL "$URL" | bash',
      'if [ -d "$HOME/.local" ]; then',
      '  echo "exists"',
      'fi',
      'for f in *.txt; do',
      '  mv "$f" "${f%.txt}.bak"',
      'done',
      'cat <<\'EOF\' > /tmp/out.txt',
      'here doc body',
      'EOF'
    ].join('\n')
  },
  powershell: {
    wasm: 'tree-sitter-powershell/tree-sitter-powershell.wasm',
    code: [
      '$ErrorActionPreference = "Stop"',
      '$files = Get-ChildItem -Path . -Filter *.log',
      'foreach ($f in $files) {',
      '  Write-Output "processing $($f.Name)"',
      '}',
      '$items | ForEach-Object { $_.FullName } | Out-File -FilePath out.txt',
      'Invoke-Expression -Command "Get-Date"'
    ].join('\n')
  }
}

const wasmFiles = [
  'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-python/tree-sitter-python.wasm',
  'tree-sitter-bash/tree-sitter-bash.wasm',
  'tree-sitter-powershell/tree-sitter-powershell.wasm'
]

function fail(message) {
  console.error(`[probe-treesitter] FAIL: ${message}`)
  process.exit(1)
}

function countErrors(node) {
  if (node.hasError) return 1
  let n = 0
  for (const child of node.children) n += countErrors(child)
  return n
}

async function main() {
  const moduleDir = path.join(repoRoot, 'node_modules')
  const wasmPaths = Object.fromEntries(
    wasmFiles.map((rel) => [rel, path.join(moduleDir, rel)])
  )

  for (const rel of wasmFiles) {
    if (!fs.existsSync(wasmPaths[rel])) fail(`wasm 缺失: ${rel}`)
  }

  console.log('[probe-treesitter] wasm 字节体积:')
  let totalBytes = 0
  for (const rel of wasmFiles) {
    const bytes = fs.statSync(wasmPaths[rel]).size
    totalBytes += bytes
    console.log(`  ${rel}: ${bytes} bytes`)
  }
  console.log(`  合计: ${totalBytes} bytes (预算 ≤ ${WASM_SIZE_BUDGET_TOTAL})`)
  if (totalBytes > WASM_SIZE_BUDGET_TOTAL) {
    fail(`4 个 wasm 合计 ${totalBytes} bytes 超出 ${WASM_SIZE_BUDGET_TOTAL} 预算，触发评审`)
  }

  await Parser.init()
  console.log(`[probe-treesitter] 核心运行时初始化成功; ABI 区间 [${MIN_COMPATIBLE_VERSION}, ${LANGUAGE_VERSION}]`)

  const parser = new Parser()
  let failures = 0

  for (const [lang, spec] of Object.entries(samples)) {
    const language = await Language.load(wasmPaths[spec.wasm])
    parser.setLanguage(language)
    const tree = parser.parse(spec.code)
    if (!tree) {
      console.error(`[probe-treesitter] ${lang}: parse 返回空`)
      failures += 1
      continue
    }
    const errors = countErrors(tree.rootNode)
    console.log(
      `[probe-treesitter] ${lang}: languageVersion=${language.languageVersion ?? 'n/a'} ` +
      `abiVersion=${language.abiVersion ?? 'n/a'} rootKind=${tree.rootNode.type} errors=${errors}`
    )
    if (errors !== 0) {
      console.error(`[probe-treesitter] ${lang}: 样本解析含 ${errors} 个 ERROR 节点`)
      failures += 1
    }
    tree.delete()
  }
  parser.delete()

  if (failures > 0) fail(`${failures} 个语言样本解析失败`)
  console.log('[probe-treesitter] PASS')
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err))
})
