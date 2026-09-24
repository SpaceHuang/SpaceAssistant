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

// 登记表生命周期（类别化豁免，P1-7 评审修复）：实现漂移先经评审登记于此
// （逐条证据见评审文档 Bash/PS 段），基线重录 commit 将已登记漂移吸收进基线后
// 随即清空登记表——残留条目会豁免未来同类别漂移，削弱比对告警。
// 2026-09 基线重录（commit 14687900，normalizeShellSignature argv 数组格式）
// 已吸收 P2/P3-T5/T6 全部 93 条登记（含 b40-b42 trusted eligible 翻转，
// 成对断言见 bashPathFork.test.ts），登记表清零。
// 约束：verdict 弱化（allow/ask 降级）、eligible false→true 的静默升级绝不入白名单；
// 三类硬禁令不可豁免（见比对逻辑）：verdict 弱化、signature 非拆分变化、eligible false→true。
// verdictStricter：判定变严；factsPrecision：facts/analysis 形态精确化；signatureSplit：显式登记的签名等价类拆分。
const SHELL_ACCEPTED_DRIFT: Record<string, { verdictStricter?: string; factsPrecision?: string; signatureSplit?: string }> = {}

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
