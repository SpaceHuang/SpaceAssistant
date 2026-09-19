// P2-T0 / P2-T5：Shell Golden 基线录制与比对（判定 + 签名 + facts + 免确认资格四类）。
//
// 录制模式（SHELL_GOLDEN_RECORD=1）：在「P2 改动前」的基线 commit 上导出每条样本的
//   ① analyzeShellCommand 判定、② normalizeShellSignature / parseShellCommandForTrust 签名、
//   ③ analyzeShellFacts 字段级 facts、④ precheckRunShellTool 派生免确认资格
// （legacyAutoAllowEligible + analysisCompleteness + persistable/hasMetasyntax；bash 全量录制，
//   裸括号形态含 trusted / untrusted 双配置——发现 H：facts 翻转 → eligible 翻转必须可见）。
// 比对模式（默认，P2-T5）：逐条 diff；判定只允许「严格不弱于基线」（rank 单调不减），
//   签名要求逐字节一致（PS 组零容忍），facts 逐字段比对。
import fs from 'node:fs'
import path from 'node:path'
import { analyzeShellCommand } from './analyzeShellCommand'
import { analyzeShellFacts } from './shellAnalyzer'
import { normalizeShellSignature } from '../confirmation/extractors/commandSequenceExtractor'
import { parseShellCommandForTrust, commandHasShellMetasyntax } from './shellCommandParser'
import { precheckRunShellTool } from './shellToolLoopHelpers'
import type { ShellConfig, TrustedShellCommand } from '../../src/shared/domainTypes'

const GOLDEN_DIR = path.resolve(__dirname, 'testdata/golden/shell')
const RECORD_MODE = process.env.SHELL_GOLDEN_RECORD === '1'

const WORK_DIR = 'WORKDIR'
const USER_DATA_DIR = 'USERDATADIR'
// 平台按样本 dialect 固定（发现 H 场景 = posix-bash 下的 bash 分析路径）：
// bash 样本 → linux；PS 样本 → win32。与运行时 process.platform 解耦，保证基线跨机器稳定。
const PLATFORM: NodeJS.Platform = 'linux'

// 发现 H：裸括号样本的 trusted 配置（命中 trustedCommands，验证 eligible 随 facts 翻转可见）
const TRUSTED_CONFIG_FOR_BARE_PAREN: ShellConfig = {
  trustedCommands: [
    {
      id: 'golden-trusted-b40',
      schemaVersion: 2,
      executable: 'echo',
      fixedArgvPrefix: ['a(b)'],
      trailingArgv: 'plain-tokens',
      createdAt: 0
    } as TrustedShellCommand
  ]
} as unknown as ShellConfig

type ShellGoldenBaseline = {
  id: string
  dialect: string
  platform: string
  analysis: Record<string, unknown>
  signature: Record<string, unknown>
  facts: Record<string, unknown>
  precheck: Record<string, unknown>
  precheckTrusted?: Record<string, unknown>
}

// P2-T5 登记表：经评审登记为「接受」的漂移 id → 处置结论（逐条证据见评审文档 Bash 段）。
// 约束：verdict 弱化（allow/ask 降级）、eligible false→true 的静默升级绝不入白名单；
// b40-b42 的 trusted eligible 翻转在 bashPathFork.test.ts 成对断言并登记论证。
const SHELL_ACCEPTED_DRIFT: Record<string, string> = {
    'b06-base64-decode-exec': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b12-semi-list': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b13-dquote': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b14-squote': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b15-mixed-quote': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b16-escaped-quote': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b18-assign-prefix': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b19-assign-echo-var': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b21-cd-dotdot': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b22-redirect-abs': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b23-redirect-append-rel': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b24-redirect-input': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b25-redirect-stderr': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b26-cmd-subst': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b27-backtick-subst': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b28-process-subst': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b30-var-brace': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b31-export-path': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b32-escape-space': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b33-printf-escapes': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b34-unicode-quote': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b35-crlf': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b36-unclosed-quote': '接受：畸形/截断命令旧实现落 ask（分段解析不报错），切换后 tree parse_error → deny 兜底（fail-closed，变严方向）',
    'b37-trailing-pipe': '接受：畸形/截断命令旧实现落 ask（分段解析不报错），切换后 tree parse_error → deny 兜底（fail-closed，变严方向）',
    'b38-leading-and': '接受：畸形/截断命令旧实现落 ask（分段解析不报错），切换后 tree parse_error → deny 兜底（fail-closed，变严方向）',
    'b39-truncated-subst': '接受：畸形/截断命令旧实现落 ask（分段解析不报错），切换后 tree parse_error → deny 兜底（fail-closed，变严方向）',
    'b40-bare-paren-echo': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b41-bare-paren-grep': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b42-bare-paren-text': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b43-redirect-sensitive': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',
    'b46-eval-var': '接受：旧 partial 源于引号内元字符误报启发式（shell-control-flow）；语法树完整解析后 complete 化，路径安全面由树事实增强（verifyPathsInWorkDir 只增不减）覆盖；desktop/remote 判定不弱化',    'p02-pipeline-foreach': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    'p03-invoke-expression': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    'p04-iex-cradle': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    'p07-here-string-outfile': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    'p08-subexpression': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    'p09-backtick-continuation': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    'p10-set-content': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-04-dquote-unicode': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-05-squote': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-09-redirect': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-10-foreach-pipe': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-12-variable-assign': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-13-if-statement': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-14-member-call': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-15-where-object': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-16-param-colon': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-17-double-quoted-var': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-20-semicolon-list': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't1-22-string-concat-arg': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-01-class-def': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-02-nested-index': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-03-backtick-lead': 'P3 接受：畸形 PS 命令 tree parse_error → deny 兜底（fail-closed 变严）',
    't2-04-nested-scriptblock': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-05-type-literal': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-06-cast-generic': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-08-multiline-pipe': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-10-double-quoted-here': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-11-switch-statement': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-12-add-range-step': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-13-enum-member-access': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-14-nested-hashtable': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-15-sub-expression-in-string': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-16-array-subexpression': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-17-param-block': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-19-method-chaining': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
    't2-20-using-namespace': 'P3 接受：PS 语法级树事实分叉——旧字符启发式 partial → complete 化（operations/paths 形态精确化）；路径安全面由树事实增强只增不减覆盖；无 eligible 静默升级（已核验）',
}

function loadSamples(): Array<{ id: string; dialect: string; code: string }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'manifest.json'), 'utf8'))
  return manifest.samples.map(({ id, dialect }: { id: string; dialect: string }) => ({
    id,
    dialect,
    code: fs.readFileSync(path.join(GOLDEN_DIR, `${id}.txt`), 'utf8')
  }))
}

function platformFor(dialect: string): NodeJS.Platform {
  return dialect === 'posix-bash' ? 'linux' : 'win32'
}

async function snapshot(id: string, dialect: string, code: string): Promise<ShellGoldenBaseline> {
  const analysis = await analyzeShellCommand(WORK_DIR, code, platformFor(dialect), null, USER_DATA_DIR)
  const trust = parseShellCommandForTrust(code, commandHasShellMetasyntax)
  const facts = analyzeShellFacts(code, dialect as never)
  const precheck = await precheckRunShellToolOn(dialect, code, null)
  void PLATFORM
  const snap: ShellGoldenBaseline = {
    id,
    dialect,
    platform: PLATFORM,
    analysis: normalizePaths(JSON.parse(JSON.stringify(analysis))),
    signature: {
      normalized: normalizeShellSignature(code),
      trust,
      persistableSingle: trust.persistable
    },
    facts: JSON.parse(JSON.stringify(facts)),
    precheck: {
      ok: precheck.ok,
      ...(precheck.ok
        ? {
            legacyAutoAllowEligible: precheck.legacyAutoAllowEligible,
            analysisCompleteness: precheck.analysis.facts?.analysisCompleteness ?? null,
            persistable: trust.persistable,
            hasMetasyntax: trust.hasMetasyntax
          }
        : { auditReason: precheck.auditReason })
    }
  }
  if (isBareParenSample(id)) {
    const precheckTrusted = await precheckRunShellToolOn(dialect, code, TRUSTED_CONFIG_FOR_BARE_PAREN)
    snap.precheckTrusted = {
      ok: precheckTrusted.ok,
      ...(precheckTrusted.ok
        ? {
            legacyAutoAllowEligible: precheckTrusted.legacyAutoAllowEligible,
            analysisCompleteness: precheckTrusted.analysis.facts?.analysisCompleteness ?? null
          }
        : { auditReason: precheckTrusted.auditReason })
    }
  }
  return snap
}

/** precheckRunShellTool 内部读取 process.platform：录制/比对统一 stub 为样本 dialect 对应平台。 */
async function precheckRunShellToolOn(dialect: string, code: string, shellConfig: ShellConfig | null) {
  const target = platformFor(dialect)
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: target })
  try {
    return await precheckRunShellTool({
      command: code,
      workDir: WORK_DIR,
      userDataDir: USER_DATA_DIR,
      shellConfig
    })
  } finally {
    if (desc) Object.defineProperty(process, 'platform', desc)
  }
}

function isBareParenSample(id: string): boolean {
  return /^b4[012]-bare-paren/.test(id)
}

function normalizePaths(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.split(WORK_DIR).join('<WORKDIR>').split(USER_DATA_DIR).join('<USERDATA>')
  }
  if (Array.isArray(value)) return value.map(normalizePaths)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizePaths(v)]))
  }
  return value
}

describe('shellGolden（Shell 判定/签名/facts/免确认资格基线，P2-T0/P2-T5）', () => {
  const samples = loadSamples()

  it('样本集规模：bash ≥ 40（含裸括号 ≥3）+ PS ≥ 10', () => {
    expect(samples.filter((s) => s.dialect === 'posix-bash').length).toBeGreaterThanOrEqual(40)
    expect(samples.filter((s) => s.dialect === 'windows-powershell').length).toBeGreaterThanOrEqual(10)
    expect(samples.filter((s) => isBareParenSample(s.id)).length).toBeGreaterThanOrEqual(3)
  })

  if (RECORD_MODE) {
    it('录制模式：导出全部样本基线 .json（仅限基线 commit 运行）', async () => {
      for (const { id, dialect, code } of samples) {
        const snap = await snapshot(id, dialect, code)
        fs.writeFileSync(path.join(GOLDEN_DIR, `${id}.json`), JSON.stringify(snap, null, 2) + '\n', 'utf8')
      }
      console.log(`[shellGolden] recorded ${samples.length} baselines into ${GOLDEN_DIR}`)
    })
  } else {
    it.each(samples)('$id：四类基线逐条比对', async (sample) => {
      const baselinePath = path.join(GOLDEN_DIR, `${sample.id}.json`)
      expect(fs.existsSync(baselinePath)).toBe(true)
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as ShellGoldenBaseline
      const current = await snapshot(sample.id, sample.dialect, sample.code)

      const drift: string[] = []
      // ① 判定：只允许严格不弱于基线（rank 单调不减）
      const rank = { allow: 0, ask: 1, deny: 2 } as Record<string, number>
      const bv = (baseline.analysis as { verdict?: string }).verdict
      const cv = (current.analysis as { verdict?: string }).verdict
      if ((rank[cv ?? 'ask'] ?? 1) < (rank[bv ?? 'ask'] ?? 1)) {
        drift.push(`verdict 弱化（禁止）: ${bv} -> ${cv}`)
      } else if (bv !== cv) {
        drift.push(`verdict 变严（登记评审）: ${bv} -> ${cv}`)
      }
      if (JSON.stringify(current.analysis) !== JSON.stringify(baseline.analysis) && bv === cv) {
        drift.push('analysis 字段变化（登记评审）')
      }
      // ② 签名：逐字节一致（等价类只拆不并，PS 组零容忍）
      if (JSON.stringify(current.signature) !== JSON.stringify(baseline.signature)) {
        drift.push('signature 变化（逐字节不一致，禁止合并等价类）')
      }
      // ③ facts：字段级比对
      if (JSON.stringify(current.facts) !== JSON.stringify(baseline.facts)) {
        drift.push('facts 变化（登记评审；analysisCompleteness 翻转须双面论证）')
      }
      // ④ 免确认资格
      if (JSON.stringify(current.precheck) !== JSON.stringify(baseline.precheck)) {
        drift.push('precheck 派生取值变化（登记评审；false→true 禁止静默）')
      }
      if (JSON.stringify(current.precheckTrusted) !== JSON.stringify(baseline.precheckTrusted)) {
        drift.push('precheckTrusted 派生取值变化（登记评审）')
      }

      if (drift.length > 0) {
        const accepted = SHELL_ACCEPTED_DRIFT[sample.id]
        if (accepted) {
          console.warn(`[shellGolden] accepted drift for ${sample.id}: ${drift.join(' | ')} — ${accepted}`)
          return
        }
        throw new Error(`Shell Golden drift for ${sample.id}: ${drift.join(' | ')}`)
      }
    })
  }
})
