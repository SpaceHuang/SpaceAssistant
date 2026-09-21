// 检查 git 跟踪的源文件不含 NUL 字节（0x00）。
// 背景：2026-10 CI 事故——sqliteDecisionCache.ts 源码中混入字面 NUL，git 将整文件
// 判为二进制（diff 不可读），且 Node 22 node:sqlite 读出时按 NUL 截断字符串，
// 测试在 CI 上失败而本地（Node 24）无法复现。本检查在 npm test 之前快速拦截。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const TEXT_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css|scss|html?|md|svg|ya?ml|xml|txt)$/

const tracked = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const offenders = []
for (const file of tracked) {
  if (!TEXT_EXTENSIONS.test(file)) continue
  let content
  try {
    content = fs.readFileSync(file)
  } catch {
    continue // 删除/重命名竞态：跳过，交由 git 状态处理
  }
  if (content.includes(0)) offenders.push(file)
}

if (offenders.length > 0) {
  console.error('以下源文件含 NUL 字节（0x00），请改用 \\x00 / \\u0000 等转义序列：')
  for (const file of offenders) console.error(`  - ${file}`)
  process.exit(1)
}
console.log(`check:no-nul OK（${tracked.length} 个跟踪文件已扫描）`)
