import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

/**
 * R1/R4 的「可 grep 护栏」（方案 §6.2 第 2 条 / §7.3 样式护栏）：
 * 失败即 CI 红，防止后续改动把已消灭的多副本路径改回来。
 */
const root = path.resolve(__dirname, '..')

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

describe('工具调用可靠性护栏（grep 断言）', () => {
  it('护栏 1：env.workspace 不再出现 getActiveWorkDir（全局 active 旁路已删除）', () => {
    const source = read('electron/capabilities/handlers/env.ts')
    const handlerSection = source.slice(source.indexOf('env.workspace'))
    expect(handlerSection).not.toContain('getActiveWorkDir')
  })

  it('护栏 2：toolChatLoop 循环内 workDir 取值以 workspaceRefresh 优先（旧三元不再是唯一路径）', () => {
    const source = read('electron/toolChatLoop.ts')
    expect(source).toContain('workspaceSnapshot?.rootPath ?? (resolveWorkDir ? resolveWorkDir() : initialWorkDir)')
    expect(source).toContain('workspaceRefresh: ports.workspace.refresh')
  })

  it('护栏 3：渲染端工具卡失败态只用 status 推导（不得用 error 字段存在性）', () => {
    const source = read('src/renderer/components/Chat/ToolCallCard.tsx')
    expect(source).toMatch(/isFailed = record\.status === 'failed' || record\.status === 'rejected'/)
    // 失败态推导不得出现「error 存在性」形态
    expect(source).not.toMatch(/status\s*=\s*[^;\n]*\??\.error/)
    expect(source).not.toMatch(/isFailed\s*=[^;\n]*\.error/)
  })

  it('护栏 4：结果信封归一只经 toolResultContract（validator 不再自建矛盾改写逻辑）', () => {
    const source = read('electron/tools/types.ts')
    expect(source).toContain('normalizeToolResultEnvelope')
    // 旧「矛盾即判失败」的静默改写路径不得回归
    expect(source).not.toMatch(/success && status === 'failed'/)
    expect(source).not.toMatch(/!normalized\.success && status === 'succeeded'/)
  })

  it('护栏 5：run_shell 失败码已细分（settle 分支不再产出旧 SHELL_ 执行失败码）', () => {
    const source = read('electron/tools/runShellExecutor.ts')
    expect(source).not.toContain("error: 'SHELL_PROCESS_EXIT'")
    expect(source).not.toContain("error: 'SHELL_TIMEOUT'")
    expect(source).not.toContain("error: 'SHELL_CANCELLED'")
    expect(source).not.toContain("error: 'SHELL_SPAWN_ERROR'")
    expect(source).not.toContain("error: 'SHELL_ARTIFACT_PATH_INVALID'")
  })

  it('护栏 6（R5）：unsupported 命令不得进入信任选项（消费点显式排除，不只依赖 requiresRiskAck）', () => {
    const trust = read('electron/shell/shellCommandTrust.ts')
    expect(trust).not.toMatch(/verdict === 'deny'\) return false/)
    expect(trust.match(/verdict !== 'allow' && .*verdict !== 'ask'/g)?.length).toBeGreaterThanOrEqual(2)
    const loop = read('electron/shell/shellToolLoopHelpers.ts')
    // 预检只对 deny 短路（unsupported 下传事实，不产出 shellPrecheckDeny）
    expect(loop).toContain("analysis.verdict === 'deny'")
  })

  it('护栏 7（R5 · O9）：automation unsupported 收敛规则存在且排在 catch-all 之前', () => {
    const rules = read('src/shared/policy/defaultRules.ts')
    const unsupportedIdx = rules.indexOf("id: 'automation-unsupported-deny'")
    const catchAllIdx = rules.indexOf("id: 'automation-default-confirm'")
    expect(unsupportedIdx).toBeGreaterThan(-1)
    expect(catchAllIdx).toBeGreaterThan(-1)
    expect(unsupportedIdx).toBeLessThan(catchAllIdx)
  })

  it('护栏 8（R5）：审批「判不了」可回退、拒绝永不回退', () => {
    const fb = read('electron/confirmation/fallbackToUser.ts')
    expect(fb).toContain("'agent-undetermined'")
    const ch = read('electron/confirmation/agentChannel.ts')
    expect(ch).toContain("cause: 'agent-undetermined'")
  })

  it('护栏 9（R6/R7）：grep 参数归一与范围规划单一出口', () => {
    const exec = read('electron/tools/builtinExecutors.ts')
    // rg glob 追加只经 planGrepInvocation（不得回归到无条件名单 glob）
    expect(exec).not.toMatch(/for \(const d of GREP_SKIP_DIRS\) rgArgs\.push/)
    expect(exec).toContain('planGrepInvocation')
    // 校验层薄壳与执行层同源
    expect(exec).toContain('normalizeGrepArgs(input)')
  })

  it('护栏 11（C2）：basis-mismatch 护栏判据不得用 NODE_ENV（打包态恒真），且两侧比较前 realpath 归一', () => {
    const source = read('electron/toolChatLoop.ts')
    expect(source).not.toContain("process.env.NODE_ENV !== 'production'")
    expect(source).toContain('isPackagedApp()')
    expect(source).toContain('realpathBestEffort(legacyWorkDir)')
  })

  it('护栏 12（B1）：unsupported 信号阻断持久记忆资格', () => {
    const mem = read('src/shared/policy/memoryEligibility.ts')
    expect(mem).toContain("signal.kind === 'shell-unsupported-structure'")
  })

  it('护栏 13（B3）：审批收束指令为三态（两态表述不得回潮）', () => {
    const agent = read('electron/confirmation/approvalAgent.ts')
    expect(agent).not.toContain('给出两态 JSON 结论')
    expect(agent).toContain('三态 JSON 结论')
  })

  it('护栏 14（F3）：contract-violation 告警只对 I0–I4（I5 不落日志）+ SCRIPT_*/LARK_* 码已闭合', () => {
    const loop = read('electron/toolChatLoop.ts')
    expect(loop).toContain("violations.some((v) => v.invariant !== 'I5')")
    const codes = read('src/shared/errorCodes.ts')
    expect(codes).toContain("'SCRIPT_TIMEOUT'")
    expect(codes).toContain("'SCRIPT_PROCESS_EXIT'")
    expect(codes).toContain("'LARK_RUNNER_UNAVAILABLE'")
  })

  it('护栏 15（D1/D2）：rg glob 大小写无关消费 + 显式点名段级判定', () => {
    const scope = read('electron/tools/grepScope.ts')
    expect(scope).toContain('caseInsensitiveGlobs: true')
    expect(scope).toContain('seg.toLowerCase()')
    const exec = read('electron/tools/builtinExecutors.ts')
    expect(exec).toContain("--iglob")
  })

  it('护栏 16（E1/E2）：MCP 入参摘要递归脱敏 + 审批渲染消费', () => {
    const ext = read('electron/confirmation/extractors/mcpPayloadExtractor.ts')
    expect(ext).toContain('redactDeep')
    const agent = read('electron/confirmation/approvalAgent.ts')
    expect(agent).toContain('[入参摘要（脱敏后）]')
  })

  it('护栏 17（N1）：B1 端到端用例的缓存 mock 必须是真实 DecisionCacheEntry 形态（decision: allow）', () => {
    const t = read('electron/toolReliabilityR5.test.ts')
    expect(t).not.toContain("decision: 'auto-allow'")
    expect(t).toContain("decision: 'allow' as const")
    expect(t).toContain('expect(r.decision.memoryTiers).toEqual([])')
    // 触达路径：命令必须是 persistable=true 形态（否则走既有 non-persistable 排除，B1 路径未被测试）
    expect(t).toContain("command: 'echo )'")
  })

  it('护栏 18（N2）：扫描门禁收 .log/.jsonl 且 files=0 非零退出', () => {
    const scan = read('scripts/scan-tool-result-invariants.mjs')
    expect(scan).toContain("endsWith('.log')")
    expect(scan).toContain('FAIL: no .log/.jsonl files scanned')
    expect(scan).toContain('process.exit(1)')
  })

  it('护栏 19（N3）：undetermined 回退文案不坍缩为 unavailable（两处透传）', () => {
    const loop = read('electron/toolChatLoop.ts')
    expect(loop).not.toContain("fallbackCause === 'timeout' ? 'timeout' : 'unavailable'")
    expect(loop).toContain("'approval_undetermined'")
  })

  it('护栏 10（R8）：目录错误四分类可分（stat 失败不再共用「不是目录或无法访问」）', () => {
    const exec = read('electron/tools/builtinExecutors.ts')
    expect(exec).toContain('classifyDirectoryError')
    expect(exec).toContain("'DIRECTORY_READ_TIMEOUT'")
    expect(exec).toContain("'DIRECTORY_ACCESS_DENIED'")
  })
})
