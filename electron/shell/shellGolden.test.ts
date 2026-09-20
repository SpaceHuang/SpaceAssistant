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
// P2/P3-T5/T6 评审登记表（类别化，P1-7 评审修复）：白名单只豁免「登记过的具体类别」；
// 三类硬禁令不可豁免（见比对逻辑）：verdict 弱化、signature 非拆分变化、eligible false→true。
// verdictStricter：判定变严；factsPrecision：facts/analysis 形态精确化；signatureSplit：显式登记的签名等价类拆分。
const SHELL_ACCEPTED_DRIFT: Record<string, { verdictStricter?: string; factsPrecision?: string; signatureSplit?: string }> = {
  'b04-curl-pipe-bash': { factsPrecision: '同 b06（URL 参数已排除路径增强误报）' },
  'b05-wget-pipe-sh': { factsPrecision: '同 b06（URL 参数已排除路径增强误报）' },
  'b07-dd-devsda': { factsPrecision: '树事实路径增强捕获 dd 的 /dev/zero→/dev/sda 写入违规（旧实现漏检，violations 新增=变严；verdict 保持 deny 不变）' },
  'b09-cat-pipe-grep': { factsPrecision: '同 b06；树事实增强额外捕获 /etc/passwd 读取违规（posix /etc 敏感前缀，violations 新增=变严）' },
  'b45-pipe-to-python': { factsPrecision: '同 b06（URL 参数已排除路径增强误报）' },
  'b06-base64-decode-exec': { factsPrecision: '旧 partial 源于引号内元字符误报启发式；语法树完整解析后 complete 化；路径安全面由树事实增强只增不减覆盖' },
  'b12-semi-list': { factsPrecision: '同 b06' },
  'b13-dquote': { factsPrecision: '同 b06' },
  'b14-squote': { factsPrecision: '同 b06' },
  'b15-mixed-quote': { factsPrecision: '同 b06' },
  'b16-escaped-quote': { factsPrecision: '同 b06' },
  'b18-assign-prefix': { factsPrecision: '同 b06' },
  'b19-assign-echo-var': { factsPrecision: '同 b06' },
  'b21-cd-dotdot': { factsPrecision: '同 b06' },
  'b22-redirect-abs': { factsPrecision: '同 b06' },
  'b23-redirect-append-rel': { factsPrecision: '同 b06' },
  'b24-redirect-input': { factsPrecision: '同 b06' },
  'b25-redirect-stderr': { factsPrecision: '同 b06' },
  'b26-cmd-subst': { factsPrecision: '同 b06' },
  'b27-backtick-subst': { factsPrecision: '同 b06' },
  'b28-process-subst': { factsPrecision: '同 b06' },
  'b29-var-home': { factsPrecision: '同 b06' },
  'b30-var-brace': { factsPrecision: '同 b06' },
  'b31-export-path': { factsPrecision: '同 b06' },
  'b32-escape-space': { factsPrecision: '同 b06' },
  'b33-printf-escapes': { factsPrecision: '同 b06' },
  'b34-unicode-quote': { factsPrecision: '同 b06' },
  'b35-crlf': { factsPrecision: '同 b06' },
  'b40-bare-paren-echo': { factsPrecision: '发现 H 锚点：complete 化；trusted eligible 翻转已在 bashPathFork 成对断言并登记论证' },
  'b41-bare-paren-grep': { factsPrecision: '发现 H 锚点：complete 化' },
  'b42-bare-paren-text': { factsPrecision: '发现 H 锚点：complete 化' },
  'b43-redirect-sensitive': { factsPrecision: '同 b06（敏感路径由 path-target 与路径增强双覆盖）' },
  'b44-cat-shadow': { factsPrecision: '同 b06' },
  'b46-eval-var': { factsPrecision: '同 b06' },
  'b47-glob-star': { factsPrecision: '同 b06' },
  'b36-unclosed-quote': { verdictStricter: '畸形命令 tree parse_error → deny 兜底（fail-closed 变严）', factsPrecision: 'complete 化与 unresolved 形态变化', signatureSplit: '签名空折叠缺陷修复（P3-T4）：未闭合引号不再折叠为空签名——旧实现全部失败输入塌缩为同一空串等价类，修复为拆分（方向安全）' },
  'b37-trailing-pipe': { verdictStricter: '畸形命令 tree parse_error → deny 兜底（fail-closed 变严）', factsPrecision: 'complete 化与 unresolved 形态变化' },
  'b38-leading-and': { verdictStricter: '畸形命令 tree parse_error → deny 兜底（fail-closed 变严）', factsPrecision: 'complete 化与 unresolved 形态变化' },
  'b39-truncated-subst': { verdictStricter: '畸形命令 tree parse_error → deny 兜底（fail-closed 变严）', factsPrecision: 'complete 化与 unresolved 形态变化' },
  't2-03-backtick-lead': { verdictStricter: '上游已知缺陷形态 ERROR → deny 兜底（fail-closed 变严）', factsPrecision: 'PS 语法级 facts 形态变化' },
  'p01-get-childitem': { factsPrecision: 'PS 语法级树事实分叉：operations/paths/connectors 按语法结构精确化（P3-T6 登记）' },
  'p02-pipeline-foreach': { factsPrecision: '同 p01' },
  'p03-invoke-expression': { factsPrecision: '同 p01' },
  'p04-iex-cradle': { verdictStricter: 'P0-2 修复后 ps-iex-cradle 模式真实生效：ask → deny（变严）', factsPrecision: '同 p01' },
  'p05-encoded-command': { factsPrecision: '同 p01' },
  'p06-remove-item-recurse': { verdictStricter: 'P0-2 修复后 ps-destructive 模式真实生效：ask → deny（变严）', factsPrecision: '同 p01' },
  'p07-here-string-outfile': { factsPrecision: '同 p01' },
  'p08-subexpression': { factsPrecision: '同 p01' },
  'p09-backtick-continuation': { factsPrecision: '同 p01' },
  'p10-set-content': { factsPrecision: '同 p01' },
  'p11-sort-pipeline': { factsPrecision: '同 p01' },
  'p12-format-volume': { verdictStricter: 'P0-2 修复后 ps-destructive 模式真实生效：ask → deny（变严）', factsPrecision: '同 p01' },
  't1-01-get-date': { factsPrecision: '同 p01' },
  't1-02-param-value': { factsPrecision: '同 p01' },
  't1-03-flag-equals': { factsPrecision: '同 p01' },
  't1-04-dquote-unicode': { factsPrecision: '同 p01' },
  't1-05-squote': { factsPrecision: '同 p01' },
  't1-06-var-member': { factsPrecision: '同 p01' },
  't1-07-and-list': { factsPrecision: '同 p01' },
  't1-08-or-list': { factsPrecision: '同 p01' },
  't1-09-redirect': { factsPrecision: '同 p01' },
  't1-10-foreach-pipe': { factsPrecision: '同 p01' },
  't1-11-splatting': { factsPrecision: '同 p01' },
  't1-12-variable-assign': { factsPrecision: '同 p01' },
  't1-13-if-statement': { factsPrecision: '同 p01' },
  't1-14-member-call': { factsPrecision: '同 p01' },
  't1-15-where-object': { factsPrecision: '同 p01' },
  't1-16-param-colon': { factsPrecision: '同 p01' },
  't1-17-double-quoted-var': { factsPrecision: '同 p01' },
  't1-18-single-dash-flag': { factsPrecision: '同 p01' },
  't1-19-negative-number-param': { factsPrecision: '同 p01' },
  't1-20-semicolon-list': { factsPrecision: '同 p01' },
  't1-21-cmdlet-format': { factsPrecision: '同 p01' },
  't1-22-string-concat-arg': { factsPrecision: '同 p01' },
  't2-01-class-def': { factsPrecision: '同 p01' },
  't2-02-nested-index': { factsPrecision: '同 p01' },
  't2-04-nested-scriptblock': { factsPrecision: '同 p01' },
  't2-05-type-literal': { factsPrecision: '同 p01' },
  't2-06-cast-generic': { factsPrecision: '同 p01' },
  't2-07-range-operator': { factsPrecision: '同 p01' },
  't2-08-multiline-pipe': { factsPrecision: '同 p01' },
  't2-09-dollar-dollar': { factsPrecision: '同 p01' },
  't2-10-double-quoted-here': { factsPrecision: '同 p01' },
  't2-11-switch-statement': { factsPrecision: '同 p01' },
  't2-12-add-range-step': { factsPrecision: '同 p01' },
  't2-13-enum-member-access': { factsPrecision: '同 p01' },
  't2-14-nested-hashtable': { factsPrecision: '同 p01' },
  't2-15-sub-expression-in-string': { factsPrecision: '同 p01' },
  't2-16-array-subexpression': { factsPrecision: '同 p01' },
  't2-17-param-block': { factsPrecision: '同 p01' },
  't2-18-filter-left': { factsPrecision: '同 p01' },
  't2-19-method-chaining': { factsPrecision: '同 p01' },
  't2-20-using-namespace': { factsPrecision: '同 p01' }
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

// P1-8 评审处置：路径判定语义（node:path / pathSecurity resolveSafePath）与宿主平台耦合，
// 全链路参数化需重构 pathSecurity，超出本次范围。Golden 固定在 win32 运行（录制平台），
// CI 由新增的 windows golden job 覆盖（ci.yml），非 win32 宿主跳过。
const describeWin = process.platform === 'win32' ? describe : describe.skip

describeWin('shellGolden（Shell 判定/签名/facts/免确认资格基线，P2-T0/P2-T5）', () => {
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

      // —— P1-c 评审修复：三类硬禁令在此直接 throw，先于任何白名单豁免判断 ——
      if ((rank[cv ?? 'ask'] ?? 1) < (rank[bv ?? 'ask'] ?? 1)) {
        throw new Error(`Shell Golden HARD-FAIL for ${sample.id}: verdict 弱化（禁止，白名单不可豁免）: ${bv} -> ${cv}`)
      }
      const eligibleFlipped =
        (baseline.precheck as { legacyAutoAllowEligible?: boolean }).legacyAutoAllowEligible === false &&
        (current.precheck as { legacyAutoAllowEligible?: boolean }).legacyAutoAllowEligible === true
      if (eligibleFlipped) {
        throw new Error(`Shell Golden HARD-FAIL for ${sample.id}: legacyAutoAllowEligible false→true（禁止，白名单不可豁免）`)
      }
      const eligibleFlippedTrusted =
        (baseline.precheckTrusted as { legacyAutoAllowEligible?: boolean } | undefined)?.legacyAutoAllowEligible === false &&
        (current.precheckTrusted as { legacyAutoAllowEligible?: boolean } | undefined)?.legacyAutoAllowEligible === true
      if (eligibleFlippedTrusted) {
        throw new Error(`Shell Golden HARD-FAIL for ${sample.id}: precheckTrusted legacyAutoAllowEligible false→true（禁止，白名单不可豁免）`)
      }

      if (drift.length > 0) {
        const accepted = SHELL_ACCEPTED_DRIFT[sample.id]
        // P1-7/P1-c 评审修复：白名单按类别豁免。三类硬禁令（verdict 弱化 / eligible false→true 含
        // trusted 配置）已在上方直接 throw，不受白名单影响；signature 仅接受显式 signatureSplit；
        // verdict 变严需 verdictStricter；facts/precheck 需 factsPrecision。
        if (accepted) {
          const covered = drift.every((d) => {
            if (d.startsWith('verdict 变严')) return Boolean(accepted.verdictStricter)
            if (d.startsWith('signature')) return Boolean(accepted.signatureSplit)
            if (d.startsWith('analysis') || d.startsWith('facts') || d.startsWith('precheck')) return Boolean(accepted.factsPrecision)
            return false
          })
          if (covered) {
            console.warn(`[shellGolden] accepted drift for ${sample.id}（类别化豁免，详见评审文档）`)
            return
          }
          throw new Error(`Shell Golden drift for ${sample.id}: 白名单类别未覆盖实际漂移（登记与实现不符）: ${drift.join(' | ')}`)
        }
        throw new Error(`Shell Golden drift for ${sample.id}: ${drift.join(' | ')}`)
      }
    })
  }
})
