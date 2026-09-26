import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { projectAgentToolResult } from '../../src/shared/agentToolResult'
import { sanitizeAgentText, setKnownHomeDir } from '../../src/shared/agentSafeText'
import {
  MAX_DIAGNOSIS_BLOCK_LINES,
  MAX_SUGGESTED_OLD_STRING_CHARS,
  MAX_LCS_INPUT_CHARS
} from '../../src/shared/toolResultLimits'
import type { ToolExecutionContext, ToolExecutorResult } from './types'
import { editFileExecutor, readFileExecutor } from './builtinExecutors'
import { attachTestReadPermit } from './readPermitTestUtils'
import { buildEscapeLayerVariants, diagnoseMissingOldString, lcsOpcodes, type EditMissingDiagnosis } from './editDiagnosis'

/**
 * edit_file 匹配失败诊断（P0-A/P0-B/P1-E）与 P1-C 转义归一回退的单测。
 * 场景编号对应 docs/develop/edit-file-match-failure-diagnosis-and-improvement-plan.md §7.1 的 18 条。
 */

function makeCtx(workDir: string, cache: FileStateCache): ToolExecutionContext {
  return {
    workDir,
    userDataDir: path.join(workDir, '.userdata'),
    requestId: 'req-test',
    toolUseId: 'tool-test',
    sessionId: 'session-test',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: cache,
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false }
  }
}

async function executePermittedRead(input: Record<string, unknown>, ctx: ToolExecutionContext) {
  await attachTestReadPermit('read_file', input, ctx)
  return readFileExecutor.execute(input, ctx)
}

// 真实案例复现（§2.3）：文件第 58 行该处为 2 个连续反斜杠，模型提交 1 个。
// JS 字面量 \\\\ = 文件中 2 个反斜杠；\\ = 1 个反斜杠。
const REAL_LINE_FILE = "wiki: `rg -n '(:\\\\s*\\\\(|=>)' src/shared/agent/invocation.ts` 说明"
const REAL_LINE_SUBMITTED = "wiki: `rg -n '(:\\s*\\(|=>)' src/shared/agent/invocation.ts` 说明"

function realCaseFile(): string {
  const fillers = Array.from({ length: 57 }, (_, i) => `filler line ${i + 1}`)
  return [...fillers, REAL_LINE_FILE, 'tail line'].join('\n')
}

async function readThenEdit(
  tmpDir: string,
  cache: FileStateCache,
  rel: string,
  input: { old_string: string; new_string: string; replace_all?: boolean; tolerate_escape_layer?: boolean }
): Promise<ToolExecutorResult> {
  const ctx = makeCtx(tmpDir, cache)
  const read = await executePermittedRead({ path: rel }, ctx)
  if (!read.success) throw new Error('read_file failed in fixture setup')
  return editFileExecutor.execute({ path: rel, ...input }, ctx)
}

function diagOf(res: ToolExecutorResult): EditMissingDiagnosis {
  if (res.success) throw new Error('expected edit_file failure, got success')
  const d = (res.data as { diagnosis?: EditMissingDiagnosis } | undefined)?.diagnosis
  if (!d) throw new Error(`expected diagnosis in data, got: ${JSON.stringify(res.data)}`)
  return d
}

describe('edit_file 匹配失败诊断（§7.1 场景）', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-edit-diag-')))
    cache = new FileStateCache()
    // 主进程运行时由 main.ts 注入 homedir()；测试显式设置并在 afterEach 重置（§5.2.1）
    setKnownHomeDir('C:\\Users\\alice')
  })

  afterEach(async () => {
    setKnownHomeDir(undefined)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('#1 真实案例复现：文件 2 个反斜杠、提交 1 个 → escape-layer-mismatch + [58,58] + 计数 2/1', async () => {
    const rel = 'doc.md'
    await fs.writeFile(path.join(tmpDir, rel), realCaseFile(), 'utf8')
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: REAL_LINE_SUBMITTED, new_string: 'x' })

    expect(res.success).toBe(false)
    expect(res.error).toBe('EDIT_OLD_STRING_NOT_FOUND')
    expect(res.userMessage).toBe('未找到待替换的字符串')
    const diag = diagOf(res)
    expect(diag.kind).toBe('escape-layer-mismatch')
    expect(diag.candidateLineRange).toEqual([58, 58])
    expect(diag.oldLineCount).toBe(1)
    expect(diag.usableAsOldString).toBe(true)
    expect(diag.diffs!.length).toBeGreaterThan(0)
    expect(diag.diffs!.every((d) => d.submittedBackslashRun === 1 && d.fileBackslashRun === 2)).toBe(true)
    expect(diag.hint).toContain('edit_file')
  })

  it('#2 用 suggestedOldString 作为 old_string 重试 → 第二次成功且建议与文件片段逐字符相等', async () => {
    const rel = 'doc.md'
    const abs = path.join(tmpDir, rel)
    const original = realCaseFile()
    await fs.writeFile(abs, original, 'utf8')
    const first = await readThenEdit(tmpDir, cache, rel, { old_string: REAL_LINE_SUBMITTED, new_string: 'x' })
    const diag = diagOf(first)
    const suggested = diag.suggestedOldString!

    expect(diag.usableAsOldString).toBe(true)
    // 建议与文件第 58 行真实内容逐字符相等
    expect(suggested).toBe(REAL_LINE_FILE)

    const ctx = makeCtx(tmpDir, cache)
    const second = await editFileExecutor.execute({ path: rel, old_string: suggested, new_string: 'replaced-line' }, ctx)
    expect(second.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe(original.replace(REAL_LINE_FILE, 'replaced-line'))
  })

  it('#3 反斜杠方向相反（文件 1 个、提交 2 个）→ 同样诊断且计数反向', async () => {
    const rel = 'doc.md'
    const fillers = Array.from({ length: 57 }, (_, i) => `filler ${i}`)
    await fs.writeFile(
      path.join(tmpDir, rel),
      [...fillers, "wiki: `rg -n '(:\\s*\\(|=>)' src/shared/agent/invocation.ts` 说明", 'tail'].join('\n'),
      'utf8'
    )
    const submitted = "wiki: `rg -n '(:\\\\s*\\\\(|=>)' src/shared/agent/invocation.ts` 说明"
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: submitted, new_string: 'x' })
    const diag = diagOf(res)
    expect(diag.kind).toBe('escape-layer-mismatch')
    expect(diag.candidateLineRange).toEqual([58, 58])
    expect(diag.diffs!.every((d) => d.submittedBackslashRun === 2 && d.fileBackslashRun === 1)).toBe(true)
  })

  it('#4 多行 old_string 中间行差一个反斜杠 → 建议覆盖整块 [X,Y] 行（B2 核心）', async () => {
    const rel = 'multi.md'
    const lines = [
      'before context',
      'const re1 = /(:\\\\s*\\\\(|=>)/',
      'const re2 = /(:\\\\s*\\\\(|=>)/',
      'after context'
    ]
    await fs.writeFile(path.join(tmpDir, rel), lines.join('\n'), 'utf8')
    // 提交的 3 行块：两行正则各漏了 1 层反斜杠（差异在行中间，非前缀截断）
    const oldMulti = ['before context', 'const re1 = /(:\\s*\\(|=>)/', 'const re2 = /(:\\s*\\(|=>)/'].join('\n')
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: oldMulti, new_string: 'x' })
    const diag = diagOf(res)
    expect(diag.kind).toBe('escape-layer-mismatch')
    expect(diag.candidateLineRange).toEqual([1, 3])
    expect(diag.oldLineCount).toBe(3)
    expect(diag.suggestedOldString!.split('\n').length).toBe(3)
    expect(diag.suggestedOldString!).toBe(lines.slice(0, 3).join('\n'))
  })

  it(`#5 行数 > MAX_DIAGNOSIS_BLOCK_LINES(${MAX_DIAGNOSIS_BLOCK_LINES}) → block-too-large 且不下发建议`, async () => {
    const rel = 'big.md'
    const blockLines = Array.from({ length: MAX_DIAGNOSIS_BLOCK_LINES + 1 }, (_, i) => `line-${i} content`)
    await fs.writeFile(path.join(tmpDir, rel), [...blockLines, 'tail'].join('\n'), 'utf8')
    // 提交块与文件几乎一致但中间行差一字符（差异在行中，确保 occ === 0 进入诊断）
    const submitted = blockLines.map((l, i) => (i === 10 ? 'line-10 contenx' : l)).join('\n')
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: submitted, new_string: 'x' })
    const diag = diagOf(res)
    expect(diag.kind).toBe('block-too-large')
    expect(diag.suggestedOldString).toBeUndefined()
    expect(diag.usableAsOldString).toBe(false)
    expect(diag.oldLineCount).toBe(MAX_DIAGNOSIS_BLOCK_LINES + 1)
  })

  it('#6 候选块含主目录绝对路径 → 抑制下发 sanitize-would-rewrite，hint 仍含行号（B1 核心）', async () => {
    const rel = 'home.md'
    const fillers = Array.from({ length: 57 }, (_, i) => `filler ${i}`)
    await fs.writeFile(
      path.join(tmpDir, rel),
      [...fillers, 'log path: C:\\Users\\alice\\notes\\todo.txt written', 'tail'].join('\n'),
      'utf8'
    )
    const res = await readThenEdit(tmpDir, cache, rel, {
      old_string: 'log path: C:\\Users\\alice\\notes\\todo.txt writen',
      new_string: 'x'
    })
    const diag = diagOf(res)
    expect(diag.usableAsOldString).toBe(false)
    expect(diag.suppressionReason).toBe('sanitize-would-rewrite')
    expect(diag.suggestedOldString).toBeUndefined()
    expect(diag.hint).toContain('58')
    expect(diag.hint).toContain('read_file')
  })

  it('#7 候选块含 TOKEN= 形态秘密文本 → 同 #6 抑制下发（B1 核心）', async () => {
    const rel = 'secret.md'
    await fs.writeFile(
      path.join(tmpDir, rel),
      ['config section:', 'TOKEN=ghp_supersecretvalue123', 'end of config'].join('\n'),
      'utf8'
    )
    const res = await readThenEdit(tmpDir, cache, rel, {
      old_string: ['config section:', 'TOKEN=ghp_supersecretvalue123', 'end of confg'].join('\n'),
      new_string: 'x'
    })
    const diag = diagOf(res)
    expect(diag.kind).toBe('content-mismatch')
    expect(diag.usableAsOldString).toBe(false)
    expect(diag.suppressionReason).toBe('sanitize-would-rewrite')
    expect(diag.suggestedOldString).toBeUndefined()
  })

  it(`#8 候选块长度 > MAX_SUGGESTED_OLD_STRING_CHARS(${MAX_SUGGESTED_OLD_STRING_CHARS}) → too-long 抑制`, async () => {
    const rel = 'long.md'
    // 候选块长度落在 (MAX_SUGGESTED_OLD_STRING_CHARS, MAX_LCS_INPUT_CHARS]：可精算但不可下发
    const longLen = MAX_SUGGESTED_OLD_STRING_CHARS + 50
    await fs.writeFile(path.join(tmpDir, rel), `prefix ${'x'.repeat(longLen)} suffix`, 'utf8')
    const res = await readThenEdit(tmpDir, cache, rel, {
      old_string: `prefix ${'x'.repeat(longLen)} suffx`,
      new_string: 'x'
    })
    const diag = diagOf(res)
    expect(diag.usableAsOldString).toBe(false)
    expect(diag.suppressionReason).toBe('too-long')
    expect(diag.suggestedOldString).toBeUndefined()
    expect(diag.hint).toContain('read_file')
  })

  it('#9 完全无关字符串 → no-similar-line，不下发建议', async () => {
    const rel = 'unrel.md'
    await fs.writeFile(path.join(tmpDir, rel), ['alpha beta', 'gamma delta', 'epsilon zeta'].join('\n'), 'utf8')
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: '完全无关的中文内容字符串', new_string: 'x' })
    const diag = diagOf(res)
    expect(diag.kind).toBe('no-similar-line')
    expect(diag.suggestedOldString).toBeUndefined()
    expect(diag.usableAsOldString).toBe(false)
    expect(diag.totalLines).toBe(3)
  })

  it('#10 top1 与 top2 相似度接近 → ambiguous-candidate 且不下发建议（O2）', async () => {
    const rel = 'amb.md'
    await fs.writeFile(
      path.join(tmpDir, rel),
      ['const valueA = computeTotalPrice(item, discount)', 'const valueB = computeTotalPrice(item, discount)'].join('\n'),
      'utf8'
    )
    const res = await readThenEdit(tmpDir, cache, rel, {
      old_string: 'const valueC = computeTotalPrice(item, discout)',
      new_string: 'x'
    })
    const diag = diagOf(res)
    expect(diag.kind).toBe('ambiguous-candidate')
    expect(diag.suggestedOldString).toBeUndefined()
    expect(diag.usableAsOldString).toBe(false)
    expect(typeof diag.similarityGap).toBe('number')
    // P2：pool 已按精算分降序，top1 ≥ top2，gap 恒非负
    expect(diag.similarityGap!).toBeGreaterThanOrEqual(0)
  })

  it('#P1 回归（评审 v1 实证）：异位词行不得凭直方图满分胜出，top1 必须是精算最优', async () => {
    const rel = 'anagram.md'
    // "edcba" 与 old_string "abcde" 字符直方图完全相同（粗筛 Dice=1.0），
    // 但 LCS 占比仅 1/5；真正只差 1 字符的 "abcdx"（LCS 占比 4/5）在第 4 行。
    // 修复前：Math.max 让粗筛分成为下限且精算后未重排 → edcba 以 similarity 1.000 胜出并被下发。
    await fs.writeFile(
      path.join(tmpDir, rel),
      ['xxxx0', 'edcba', 'xxxx2', 'abcdx', 'xxxx4'].join('\n'),
      'utf8'
    )
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: 'abcde', new_string: 'x' })
    const diag = diagOf(res)
    expect(diag.kind).toBe('content-mismatch')
    expect(diag.candidateLineRange).toEqual([4, 4])
    expect(diag.similarity).toBeCloseTo(0.8, 5)
    expect(diag.suggestedOldString).toBe('abcdx')
    expect(diag.usableAsOldString).toBe(true)
  })

  it('#P1.5 回归（评审 v1）：粗筛相似窗口数超过 MAX_CANDIDATES 时判歧义，即使 top1/top2 差距大', async () => {
    const rel = 'too-many.md'
    // 6 个异位词行（字符集同 "abcde"、乱序 → 粗筛满分、精算占比极低）+ 1 个真目标行（差 1 字符）：
    // 粗筛全量 ≥0.5 的窗口共 7 个 > MAX_CANDIDATES(5)；精算后仅真目标窗口 ≥0.5（top2 不存在，
    // gap 条件不触发）——只有 coarseAboveCount 路径能拦下该场景，防止向 6 个相似块中下发建议。
    const anagrams = ['edcba', 'badce', 'cebad', 'dabce', 'ebcda', 'cbade']
    await fs.writeFile(
      path.join(tmpDir, rel),
      [...anagrams.slice(0, 3), 'abcdf', ...anagrams.slice(3)].join('\n'),
      'utf8'
    )
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: 'abcde', new_string: 'x' })
    const diag = diagOf(res)
    expect(diag.kind).toBe('ambiguous-candidate')
    expect(diag.suggestedOldString).toBeUndefined()
    expect(diag.usableAsOldString).toBe(false)
    // top1 仍是精算最优的真目标窗口（第 4 行，LCS 占比 4/5）；top2 为某异位词窗口（LCS 3/5 = 0.6），
    // gap = 0.2 ≥ 0 且 ≥ MIN_SIM_GAP——本用例的歧义判定只能来自 coarseAboveCount 路径
    expect(diag.candidateLineRange).toEqual([4, 4])
    expect(diag.similarity).toBeCloseTo(0.8, 5)
    expect(diag.similarityGap).toBeCloseTo(0.2, 5)
  })

  it('#11 多处命中（occ > 1）→ 仍返回原文案，不进入诊断分支（回归）', async () => {
    const rel = 'dup.md'
    await fs.writeFile(path.join(tmpDir, rel), ['repeat me', 'repeat me'].join('\n'), 'utf8')
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: 'repeat me', new_string: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('找到多个匹配，请提供更精确的上下文或使用 replace_all')
    expect(res.data).toBeUndefined()
  })

  it('#12 行尾差异（文件 CRLF、提交 LF）→ EOL 容差成功，不产生诊断（回归）', async () => {
    const rel = 'crlf.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'first line\r\nsecond line\r\n', 'utf8')
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: 'second line', new_string: 'SECOND LINE' })
    expect(res.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('first line\r\nSECOND LINE\r\n')
  })

  it('#13 old_string 为空（新建文件）→ 行为不变（回归）', async () => {
    const rel = 'new-file.md'
    const res = await editFileExecutor.execute({ path: rel, old_string: '', new_string: 'brand new' }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
    expect(await fs.readFile(path.join(tmpDir, rel), 'utf8')).toBe('brand new')
  })

  it('#14 文件未读 → 未读错误，诊断不介入（回归）', async () => {
    const rel = 'unread.md'
    await fs.writeFile(path.join(tmpDir, rel), 'content here', 'utf8')
    const res = await editFileExecutor.execute({ path: rel, old_string: 'content here', new_string: 'x' }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(false)
    expect(res.error).toBe('文件尚未在本会话中通过 read_file 读取，请先读取后再编辑')
    expect(res.data).toBeUndefined()
  })

  it('#15 文件被外部修改 → 报外部修改错误，行为不变（回归）', async () => {
    const rel = 'ext.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'v1 content', 'utf8')
    const ctx = makeCtx(tmpDir, cache)
    expect((await executePermittedRead({ path: rel }, ctx)).success).toBe(true)
    await fs.writeFile(abs, 'v2 changed by external program', 'utf8')
    const res = await editFileExecutor.execute({ path: rel, old_string: 'v1 content', new_string: 'x' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toBe('文件已被外部程序修改，请重新读取后再编辑')
    expect(res.data).toBeUndefined()
  })

  it(`#16 性能上界：块超 MAX_LCS_INPUT_CHARS(${MAX_LCS_INPUT_CHARS}) 降级 block-too-large；扫描耗时随规模至多线性且常数有界`, async () => {
    const rel = 'perf-huge.md'
    // 超长单行（> MAX_LCS_INPUT_CHARS）→ 粗筛达标但无法精算 → block-too-large
    const hugeLine = 'y'.repeat(MAX_LCS_INPUT_CHARS + 100)
    await fs.writeFile(path.join(tmpDir, rel), `start ${hugeLine} end`, 'utf8')
    const res = await readThenEdit(tmpDir, cache, rel, { old_string: `start ${hugeLine} enX`, new_string: 'x' })
    expect(diagOf(res).kind).toBe('block-too-large')
    expect(diagOf(res).suggestedOldString).toBeUndefined()

    // n 行 vs 10n 行：两阶段（粗筛线性 + LCS 仅短名单）使耗时比 ≲ 15（宽松上界，防 CI 抖动）
    // 仅第 51 行含 'unique-needle-token'，其余为低重合填料行——top1 唯一、粗筛 ≥0.5 窗口仅 1 个
    const mkFile = (rows: number) =>
      Array.from({ length: rows }, (_, i) =>
        i === 50 ? 'anchor-50 unique-needle-token' : `row-${i} lorem ipsum dolor`
      ).join('\n')
    const smallRel = 'perf-small.md'
    const largeRel = 'perf-large.md'
    await fs.writeFile(path.join(tmpDir, smallRel), mkFile(500), 'utf8')
    await fs.writeFile(path.join(tmpDir, largeRel), mkFile(5000), 'utf8')
    const needle = 'anchor-50 unique-needle-tokenX'

    const t1 = Date.now()
    const resSmall = await readThenEdit(tmpDir, new FileStateCache(), smallRel, { old_string: needle, new_string: 'x' })
    const smallMs = Math.max(Date.now() - t1, 1)
    const t2 = Date.now()
    const resLarge = await readThenEdit(tmpDir, new FileStateCache(), largeRel, { old_string: needle, new_string: 'x' })
    const largeMs = Math.max(Date.now() - t2, 1)

    expect(largeMs).toBeLessThan(10_000)
    expect(largeMs / smallMs).toBeLessThan(15)
    // 10 倍规模下诊断仍正确（anchor-50 行唯一且相似度最高；差异为提交多出的 X → content-mismatch）
    expect(diagOf(resSmall).kind).toBe('content-mismatch')
    expect(diagOf(resLarge).kind).toBe('content-mismatch')
    expect(diagOf(resLarge).candidateLineRange).toEqual([51, 51])
  })

  it('#17 预检与投影一致性：预检判定与 projectAgentToolResult 真实投影结果一致', async () => {
    // ① 注入 homeDir：候选含主目录路径 → 预检抑制（投影层对同一文本确实会改写）
    const homeCandidate = 'log path: C:\\Users\\alice\\notes\\todo.txt written'
    const relHome = 'cons-home.md'
    await fs.writeFile(path.join(tmpDir, relHome), ['head', homeCandidate, 'tail end'].join('\n'), 'utf8')
    const resHome = await readThenEdit(tmpDir, cache, relHome, {
      old_string: 'log path: C:\\Users\\alice\\notes\\todo.txt wriitten',
      new_string: 'x'
    })
    const diagHome = diagOf(resHome)
    expect(diagHome.suppressionReason).toBe('sanitize-would-rewrite')
    expect(sanitizeAgentText(homeCandidate).text).not.toBe(homeCandidate)
    // 执行器抑制后，投影结果里也不可能出现 suggestedOldString（不存在的字段无从改写）
    const projectedHome = projectAgentToolResult({
      success: false,
      data: { diagnosis: diagHome },
      error: 'EDIT_OLD_STRING_NOT_FOUND',
      userMessage: '未找到待替换的字符串'
    })
    expect((projectedHome.data as { diagnosis: { suggestedOldString?: string } }).diagnosis.suggestedOldString).toBeUndefined()

    // ② 注入 homeDir：安全候选 → 执行器下发；投影后 suggestedOldString 与原文逐字符相等
    const safeCandidate = 'plain safe content line without secrets'
    const relSafe = 'cons-safe.md'
    await fs.writeFile(path.join(tmpDir, relSafe), ['head', safeCandidate, 'tail end'].join('\n'), 'utf8')
    const resSafe = await readThenEdit(tmpDir, cache, relSafe, {
      old_string: 'plain safe content line without secretx',
      new_string: 'x'
    })
    const diagSafe = diagOf(resSafe)
    expect(diagSafe.usableAsOldString).toBe(true)
    const projectedSafe = projectAgentToolResult({
      success: false,
      data: { diagnosis: diagSafe },
      error: 'EDIT_OLD_STRING_NOT_FOUND',
      userMessage: '未找到待替换的字符串'
    })
    expect((projectedSafe.data as { diagnosis: { suggestedOldString?: string } }).diagnosis.suggestedOldString).toBe(safeCandidate)

    // ③ homeDir 未注入：同一 homeRules 状态下预检与投影同判定（不产生「预检说安全、投影却改写」的漂移）
    setKnownHomeDir(undefined)
    const resNoHome = await readThenEdit(tmpDir, cache, relHome, {
      old_string: 'log path: C:\\Users\\alice\\notes\\todo.txt wriitten',
      new_string: 'x'
    })
    const diagNoHome = diagOf(resNoHome)
    const projectionRewrites = sanitizeAgentText(homeCandidate).text !== homeCandidate
    const projectedNoHome = projectAgentToolResult({
      success: false,
      data: { diagnosis: diagNoHome },
      error: 'EDIT_OLD_STRING_NOT_FOUND',
      userMessage: '未找到待替换的字符串'
    })
    const suggestedNoHome = (projectedNoHome.data as { diagnosis: { suggestedOldString?: string } }).diagnosis.suggestedOldString
    if (projectionRewrites) {
      expect(diagNoHome.usableAsOldString).toBe(false)
      expect(suggestedNoHome).toBeUndefined()
    } else {
      // 未注入时不折叠 → 预检下发，投影同样不折叠 → 建议逐字符保留（一致性保持，无最差路径）
      expect(diagNoHome.usableAsOldString).toBe(true)
      expect(suggestedNoHome).toBe(homeCandidate)
    }
  })

  describe('#18 P1-C 转义归一回退（默认关闭）', () => {
    it('默认关闭：层数差异仍走诊断分支，不自动改写', async () => {
      const rel = 'p1c-off.md'
      await fs.writeFile(path.join(tmpDir, rel), 'const re = /a\\\\s+/', 'utf8') // 文件 2 个反斜杠
      const res = await readThenEdit(tmpDir, cache, rel, { old_string: 'const re = /a\\s+/', new_string: 'const re = REPLACED' })
      expect(res.success).toBe(false)
      expect(res.error).toBe('EDIT_OLD_STRING_NOT_FOUND')
      expect(diagOf(res).kind).toBe('escape-layer-mismatch')
    })

    it('显式开启 + 唯一命中 → 自动完成编辑并标注 matchedVariant/notice', async () => {
      const rel = 'p1c-on.md'
      const abs = path.join(tmpDir, rel)
      await fs.writeFile(abs, 'const re = /a\\\\s+/', 'utf8') // 文件 2 个反斜杠
      const res = await readThenEdit(tmpDir, cache, rel, {
        old_string: 'const re = /a\\s+/',
        new_string: 'const re = REPLACED',
        tolerate_escape_layer: true
      })
      expect(res.success).toBe(true)
      const data = res.data as { matchedVariant: { kind: string; backslashRunDelta: number }; notice: string }
      expect(data.matchedVariant).toEqual({ kind: 'escape-layer', backslashRunDelta: 1 })
      expect(data.notice).toContain('反斜杠')
      expect(await fs.readFile(abs, 'utf8')).toBe('const re = REPLACED')
    })

    it('字面 \\n ↔ 真实换行变体唯一命中 → literal-newline 回退', async () => {
      const rel = 'p1c-lf.md'
      const abs = path.join(tmpDir, rel)
      await fs.writeFile(abs, 'line1\nline2\n', 'utf8')
      const res = await readThenEdit(tmpDir, cache, rel, {
        old_string: 'line1\\nline2',
        new_string: 'merged',
        tolerate_escape_layer: true
      })
      expect(res.success).toBe(true)
      expect((res.data as { matchedVariant: { kind: string } }).matchedVariant.kind).toBe('literal-newline')
      expect(await fs.readFile(abs, 'utf8')).toBe('merged\n')
    })

    it('两个变体都命中 → 不回退，退回诊断路径（歧义保护）', async () => {
      const rel = 'p1c-amb.md'
      // old = 'first a\s b\\s'：变体 A（run1 +1）= 'first a\\s b\\s' 命中第一行；变体 B（run2 -1）= 'first a\s b\s' 命中第二行
      await fs.writeFile(path.join(tmpDir, rel), ['first a\\\\s b\\\\s', 'zzz first a\\s b\\s'].join('\n'), 'utf8')
      const res = await readThenEdit(tmpDir, cache, rel, {
        old_string: 'first a\\s b\\\\s',
        new_string: 'x',
        tolerate_escape_layer: true
      })
      expect(res.success).toBe(false)
      expect(res.error).toBe('EDIT_OLD_STRING_NOT_FOUND')
      expect(diagOf(res)).toBeDefined()
    })
  })
})

describe('editDiagnosis 纯函数', () => {
  afterEach(() => setKnownHomeDir(undefined))

  it('lcsOpcodes：insert 段与 equal 段正确生成，且偏移自洽', () => {
    const ops = lcsOpcodes('abc', 'aXbc')
    let ai = 0
    let bi = 0
    for (const op of ops) {
      expect(op.i1).toBe(ai)
      expect(op.j1).toBe(bi)
      ai = op.i2
      bi = op.j2
      if (op.tag === 'equal') expect('abc'.slice(op.i1, op.i2)).toBe('aXbc'.slice(op.j1, op.j2))
    }
    expect(ai).toBe(3)
    expect(bi).toBe(4)
    expect(ops.some((op) => op.tag === 'insert')).toBe(true)
  })

  it('buildEscapeLayerVariants：生成 ±1 反斜杠与字面换行变体，不包含原串', () => {
    const oldNorm = 'a\\s\\n b\\\\s' // a \ s \ n 空格 b \ \ s
    const variants = buildEscapeLayerVariants(oldNorm)
    const texts = variants.map((v) => v.text)
    // run1(1 个反斜杠) +1
    expect(texts).toContain('a\\\\s\\n b\\\\s')
    // run2(2 个反斜杠) ±1
    expect(texts).toContain('a\\s\\n b\\\\\\s')
    expect(texts).toContain('a\\s\\n b\\s')
    // 字面 \n → 真实换行
    expect(texts).toContain('a\\s\n b\\\\s')
    expect(texts).not.toContain(oldNorm)
    for (const v of variants.filter((x) => x.kind === 'escape-layer')) {
      expect(Math.abs(v.backslashRunDelta)).toBe(1)
    }
    for (const v of variants.filter((x) => x.kind === 'literal-newline')) {
      expect(v.text).toContain('\n')
    }
  })

  it('diagnoseMissingOldString 与匹配器同口径：CRLF 文件行号按归一视图度量', () => {
    setKnownHomeDir('C:\\Users\\alice')
    const fileText = 'first\r\nplain alpha beta gamma done\r\nthird'
    const diag = diagnoseMissingOldString(fileText, 'plain alpha beta gamma don')
    expect(diag.kind).toBe('content-mismatch')
    // CRLF 不影响行号度量（归一视图）：目标在第 2 行
    expect(diag.totalLines).toBe(3)
    expect(diag.candidateLineRange).toEqual([2, 2])
  })
})
