#!/usr/bin/env node
/**
 * R4（§4.4.4）：历史事件流全量扫描——信封矛盾数为 0 门禁。
 *
 * 输入：JSON Lines 日志（开发态 `logs/*.jsonl`；打包态 `{workDir}/.agent/logs/**`，
 * 经 argv 传入；缺省扫 `<项目根>/logs/`）。每行尝试 JSON.parse，深搜
 * 「工具结果信封形状」的节点（success 为 boolean 且携带 error / data.status /
 * data.exitCode / notExecuted 任一），套 I1–I4 不变量。
 *
 * 输出：docs/develop/tool-result-invariants-scan-report.md（矛盾清单）；
 * 退出码：发现矛盾 → 1，否则 0。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 判定单个节点是否是工具结果信封形状（扫描用，宽松识别） */
export function isEnvelopeLike(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false
  if (typeof node.success !== 'boolean') return false
  const data = node.data
  const dataLooksProcess =
    !!data && typeof data === 'object' &&
    (('status' in data) || ('exitCode' in data) || ('terminationReason' in data))
  return 'error' in node || 'notExecuted' in node || dataLooksProcess
}

/** 对单个信封节点做不变量检查（I1–I4，事件粒度可判定的子集） */
export function scanEnvelope(node, at) {
  const violations = []
  const data = node.data && typeof node.data === 'object' ? node.data : undefined
  const exitCode = typeof data?.exitCode === 'number' ? data.exitCode : undefined
  const terminationReason = typeof data?.terminationReason === 'string' ? data.terminationReason : undefined
  const status = typeof data?.status === 'string' ? data.status : undefined
  const aborted = status === 'cancelled'
  const timedOut = terminationReason === 'timeout'

  const snapshot = JSON.stringify({
    success: node.success,
    error: node.error,
    status,
    exitCode,
    terminationReason,
    notExecuted: node.notExecuted,
    notExecutedReason: node.notExecutedReason
  })
  // I1：成功分支不得携带 error / notExecuted
  if (node.success === true && ('error' in node || node.notExecuted === true)) {
    violations.push({ invariant: 'I1', detail: 'success=true 与 error/notExecuted 并存', at, snapshot })
  }
  // I2：有事实依据的成功不得被判失败
  if (exitCode === 0 && terminationReason === 'process_exit' && !aborted && node.success !== true) {
    violations.push({ invariant: 'I2', detail: 'exitCode=0 + process_exit 被判失败', at, snapshot })
  }
  // I3：未执行必须带原因
  if (node.notExecuted === true && (typeof node.notExecutedReason !== 'string' || !node.notExecutedReason)) {
    violations.push({ invariant: 'I3', detail: 'notExecuted=true 缺 notExecutedReason', at, snapshot })
  }
  // I4：非零退出 / 中止 / 超时不得被判成功
  if (node.success === true && ((exitCode !== undefined && exitCode !== 0) || aborted || timedOut)) {
    violations.push({
      invariant: 'I4',
      detail: aborted ? '用户取消被判成功' : timedOut ? '超时被判成功' : 'exitCode!=0 被判成功',
      at,
      snapshot
    })
  }
  return violations
}

/** 深搜一个已解析 JSON 值中的信封形状节点并返回矛盾（depth 限界防循环） */
export function collectViolations(value, at, depth = 0, seen = new Set()) {
  if (depth > 12 || value == null || typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)
  const out = []
  if (isEnvelopeLike(value)) out.push(...scanEnvelope(value, at))
  if (Array.isArray(value)) {
    for (const item of value) out.push(...collectViolations(item, at, depth + 1, seen))
  } else {
    for (const item of Object.values(value)) out.push(...collectViolations(item, at, depth + 1, seen))
  }
  return out
}

/** 扫描单个 JSONL 文本（多行） */
export function scanJsonlText(text, source) {
  const out = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    out.push(...collectViolations(parsed, `${source}:${i + 1}`))
  }
  return out
}

function listJsonlFiles(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.log'))) out.push(full)
    }
  }
  walk(root, 0)
  return out.sort()
}

function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const roots = process.argv.length > 2 ? process.argv.slice(2) : [path.join(projectRoot, 'logs')]
  const files = [...new Set(roots.flatMap((r) => listJsonlFiles(path.resolve(r))))]

  let scanned = 0
  const violations = []
  for (const file of files) {
    scanned += 1
    violations.push(...scanJsonlText(fs.readFileSync(file, 'utf8'), path.relative(projectRoot, file)))
  }

  const reportPath = path.join(projectRoot, 'docs', 'develop', 'tool-result-invariants-scan-report.md')
  const lines = [
    '# 工具结果信封不变量扫描报告（R4 §4.4.4）',
    '',
    `- 扫描时间：${new Date().toISOString()}`,
    `- 扫描根：${roots.join(', ')}`,
    `- 扫描文件数：${scanned}`,
    `- 矛盾数：${violations.length}`,
    ''
  ]
  if (violations.length === 0) {
    lines.push('未发现信封矛盾（I1–I4 通过）。')
  } else {
    lines.push('| 不变量 | 位置 | 详情 | 字段快照 |', '| --- | --- | --- | --- |')
    for (const v of violations.slice(0, 200)) {
      lines.push(`| ${v.invariant} | ${v.at} | ${v.detail} | ${v.snapshot ?? ''} |`)
    }
  }
  lines.push('')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')

  console.log(`[scan-tool-result-invariants] files=${scanned} violations=${violations.length}`)
  console.log(`report: ${path.relative(process.cwd(), reportPath)}`)
  if (scanned === 0) {
    // N2（评审 v2）：files=0 = 门禁空转（没读过任何日志）——「矛盾数 0」无意义，必须红。
    console.error('[scan-tool-result-invariants] FAIL: no .log/.jsonl files scanned — the gate ran on empty input. Pass a real log directory (dev: <root>/logs, packaged: <workDir>/.agent/logs).')
    process.exit(1)
  }
  process.exit(violations.length > 0 ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
