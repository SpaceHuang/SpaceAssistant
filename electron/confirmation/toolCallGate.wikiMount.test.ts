/**
 * T1.2/T1.3/T1.4/T1.10：gate 层挂载接入。
 * - T1.2：写探测/读探测/微信 media 探测以 resolveWikiMount 构造锚点传入；wiki 停用不传
 * - T1.3：sensitiveRootExemptions（豁免优先，含祖先级前缀场景）
 * - T1.4：写范围分类基准 scopeBase（挂载 → inside-workdir）
 * - T1.10：wiki-raw 信号反向识别（realBase 绝对形态 → wiki-raw-target）
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase, type AppDatabase } from '../database'
import { resetRunningRemoteAgentRegistryForTests } from '../remote/remoteAgentRegistry'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { RemoteContext } from '../tools/types'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG, type ToolsConfig, type WikiConfig } from '../../src/shared/domainTypes'
import type { ExecutionLane, SecurityAuditEvent } from '../../src/shared/confirmation/types'

const shells: AppDatabase[] = []
const dirs: string[] = []

afterEach(() => {
  shells.splice(0).forEach((db) => db.close())
  resetRunningRemoteAgentRegistryForTests()
  for (const dir of dirs.splice(0)) {
    fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function tmpdir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return fs.realpath(dir)
}

const toolsConfig = (): ToolsConfig => ({ ...DEFAULT_TOOLS_CONFIG, deniedTools: [] })

function wikiConfigEnabled(): WikiConfig {
  return { ...DEFAULT_WIKI_CONFIG, enabled: true, rootPath: 'llm-wiki' }
}

function remoteContext(source: 'feishu' | 'wechat'): RemoteContext {
  return { source, messageId: 'm1', confirmPolicy: 'im_confirm' }
}

let seq = 0
function base(overrides: Partial<ToolCallGateArgs> = {}): ToolCallGateArgs {
  const lane: ExecutionLane = overrides.remoteContext
    ? (overrides.remoteContext.source === 'feishu' ? 'feishu' : 'wechat')
    : 'desktop'
  return {
    toolName: 'read_file',
    toolInput: { path: 'a.txt' },
    sessionId: 's1',
    requestId: `wiki-gate-req-${++seq}`,
    toolUseId: `wiki-gate-tool-${seq}`,
    workDir: os.tmpdir(),
    userDataDir: path.join(os.tmpdir(), 'wiki-gate-ud'),
    toolsConfig: toolsConfig(),
    audit: { record: (_e: SecurityAuditEvent) => undefined },
    effectiveRules: DEFAULT_POLICY_RULES,
    lanePackage: 'standard',
    decisionCache: {
      lookup: () => null,
      record: () => undefined,
      clear: () => 0,
      clearAllSession: () => 0,
      expireDormant: () => 0
    },
    shellPrecheck: { touchTrustedCommand: () => undefined },
    ...overrides
  } as ToolCallGateArgs
}

/** 搭建 userData({tmp}/ud) + realBase({tmp}/ud/llm-wiki) + workDir 三目录结构 */
async function setupWikiWorld(): Promise<{ workDir: string; userDataDir: string; realBase: string }> {
  const root = await tmpdir('wiki-gate-')
  const workDir = await fs.mkdir(path.join(root, 'proj'), { recursive: true }).then(() => path.join(root, 'proj'))
  const userDataDir = await fs.mkdir(path.join(root, 'ud'), { recursive: true }).then(() => path.join(root, 'ud'))
  const realBase = path.join(userDataDir, 'llm-wiki')
  await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })
  await fs.mkdir(path.join(realBase, 'raw'), { recursive: true })
  await fs.writeFile(path.join(realBase, 'wiki', 'index.md'), 'shared index')
  await fs.writeFile(path.join(realBase, 'raw', 'note.txt'), 'raw note')
  return { workDir, userDataDir, realBase }
}

function signalOf(facts: ToolCallGateArgs extends never ? never : { signals: Array<{ kind: string }> }, kind: string): Record<string, unknown> | undefined {
  return (facts.signals as Array<Record<string, unknown>>).find((s) => s.kind === kind)
}

describe('gate 挂载接入（T1.2 写/读/media 三探测点）', () => {
  it('T1.2① 写挂载：path-target.path 为 realBase 下真实路径（锚点生效）', async () => {
    const { workDir, userDataDir, realBase } = await setupWikiWorld()
    const r = await evaluateToolCallGate(base({
      toolName: 'write_file',
      toolInput: { path: 'llm-wiki/wiki/index.md', content: 'x' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    const sig = signalOf(r.facts, 'path-target')
    // T1.6②：审批卡片展示词汇路径（真实路径不进渲染层）；探测层 normalizedPath 断言在探测测试覆盖
    expect(sig?.path).toBe('llm-wiki/wiki/index.md')
  })

  it('T1.2② wiki 停用：探测入参与现状一致（workDir 词法路径、inside-workdir）', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    await fs.mkdir(path.join(workDir, 'llm-wiki', 'wiki'), { recursive: true })
    const r = await evaluateToolCallGate(base({
      toolName: 'write_file',
      toolInput: { path: 'llm-wiki/wiki/index.md', content: 'x' },
      workDir,
      userDataDir,
      wikiConfig: { ...wikiConfigEnabled(), enabled: false }
    }))
    const sig = signalOf(r.facts, 'path-target')
    expect(sig?.path).toBe(path.join(workDir, 'llm-wiki', 'wiki', 'index.md'))
    expect(signalOf(r.facts, 'write-target-scope')?.scope).toBe('inside-workdir')
  })

  it('T1.2③ 微信 media 探测同验：wiki 附件真实路径在 userData → outside-workdir → locked deny', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    const r = await evaluateToolCallGate(base({
      toolName: 'wechat_send',
      toolInput: { filePath: 'llm-wiki/raw/note.txt', text: 'hi' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled(),
      remoteContext: remoteContext('wechat')
    }))
    expect(r.decision.type).toBe('deny')
    expect(r.diagnostics?.ruleId).toBe('remote-wechat-media-outside-deny')
  })
})

describe('gate 敏感 zone 豁免（T1.3）', () => {
  it('T1.3① 读挂载 wiki 页：zone=workdir-normal（desktop 免确认档）', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    const r = await evaluateToolCallGate(base({
      toolName: 'read_file',
      toolInput: { path: 'llm-wiki/wiki/index.md' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(signalOf(r.facts, 'path-target')?.zone).toBe('workdir-normal')
    expect(['allow', 'auto-allow']).toContain(r.decision.type)
  })

  it('T1.3② userData 其他路径照旧 sensitive（desktop 逐次确认）', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    await fs.mkdir(path.join(userDataDir, 'secrets'), { recursive: true })
    await fs.writeFile(path.join(userDataDir, 'secrets', 'token.txt'), 'x')
    const r = await evaluateToolCallGate(base({
      toolName: 'read_file',
      toolInput: { path: path.join(userDataDir, 'secrets', 'token.txt') },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(signalOf(r.facts, 'path-target')?.zone).toBe('sensitive-file')
    expect(r.decision.type).toBe('require-confirm')
  })

  it("T1.3④ 祖先级前缀不漏：userData 位于 home/AppData/Roaming 下时豁免仍压过祖先命中（win32 语义）", async () => {
    if (process.platform !== 'win32') return
    const root = await tmpdir('wiki-gate-anc-')
    const home = root
    const userDataDir = path.join(home, 'AppData', 'Roaming', 'app')
    const realBase = path.join(userDataDir, 'llm-wiki')
    await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })
    await fs.writeFile(path.join(realBase, 'wiki', 'index.md'), 'x')
    const workDir = path.join(root, 'proj')
    await fs.mkdir(workDir, { recursive: true })

    const r = await evaluateToolCallGate(base({
      toolName: 'read_file',
      toolInput: { path: 'llm-wiki/wiki/index.md' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(signalOf(r.facts, 'path-target')?.zone).toBe('workdir-normal')

    // 同一根下非 wiki 的 userData 路径仍 sensitive（豁免面不外溢）
    await fs.mkdir(path.join(userDataDir, 'secrets'), { recursive: true })
    await fs.writeFile(path.join(userDataDir, 'secrets', 'token.txt'), 'x')
    const r2 = await evaluateToolCallGate(base({
      toolName: 'read_file',
      toolInput: { path: path.join(userDataDir, 'secrets', 'token.txt') },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(signalOf(r2.facts, 'path-target')?.zone).toBe('sensitive-file')
  })

  it('T1.3⑤ automation lane 读挂载 wiki 页通过（zone 豁免生效）', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    const r1 = await evaluateToolCallGate(base({
      toolName: 'read_file',
      toolInput: { path: 'llm-wiki/wiki/index.md' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled(),
      lane: 'automation'
    }))
    expect(signalOf(r1.facts, 'path-target')?.zone).toBe('workdir-normal')
    expect(['allow', 'auto-allow']).toContain(r1.decision.type)

    // automation 读 userData 其他路径仍 deny（豁免面不外溢 → automation-sensitive-path-deny）
    await fs.mkdir(path.join(userDataDir, 'secrets'), { recursive: true })
    await fs.writeFile(path.join(userDataDir, 'secrets', 'token.txt'), 'x')
    const r2 = await evaluateToolCallGate(base({
      toolName: 'read_file',
      toolInput: { path: path.join(userDataDir, 'secrets', 'token.txt') },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled(),
      lane: 'automation'
    }))
    expect(signalOf(r2.facts, 'path-target')?.zone).toBe('sensitive-file')
    expect(r2.decision.type).toBe('deny')
    expect(r2.diagnostics?.ruleId).toBe('automation-sensitive-path-deny')
  })
})

describe('写范围分类基准（T1.4）', () => {
  it('T1.4① 挂载目标 → write-target-scope inside-workdir', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    const r = await evaluateToolCallGate(base({
      toolName: 'write_file',
      toolInput: { path: 'llm-wiki/wiki/new.md', content: 'x' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(signalOf(r.facts, 'write-target-scope')?.scope).toBe('inside-workdir')
  })

  it('T1.4② workDir 外真实越界 → outside-workdir 不变', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    const outsideParent = await tmpdir('wiki-gate-out-')
    const r = await evaluateToolCallGate(base({
      toolName: 'write_file',
      toolInput: { path: path.join(outsideParent, 'evil.md'), content: 'x' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(signalOf(r.facts, 'write-target-scope')?.scope).toBe('outside-workdir')
  })
})

describe('wiki-raw 信号反向识别（T1.10）', () => {
  it('T1.10① 词汇形态 raw → wiki-raw-target（现状保持）', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    const r = await evaluateToolCallGate(base({
      toolName: 'write_file',
      toolInput: { path: 'llm-wiki/raw/x.md', content: 'x' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(r.facts.signals.some((s) => s.kind === 'wiki-raw-target')).toBe(true)
    expect(r.decision.type).toBe('deny')
    expect(r.diagnostics?.ruleId).toBe('wiki-raw-write-deny')
  })

  it('T1.10③ realBase 绝对形态 raw → 反向命中 wiki-raw-target（desktop deny）', async () => {
    const { workDir, userDataDir, realBase } = await setupWikiWorld()
    const r = await evaluateToolCallGate(base({
      toolName: 'write_file',
      toolInput: { path: path.join(realBase, 'raw', 'abs.md'), content: 'x' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(r.facts.signals.some((s) => s.kind === 'wiki-raw-target')).toBe(true)
    expect(r.decision.type).toBe('deny')
    expect(r.diagnostics?.ruleId).toBe('wiki-raw-write-deny')
  })

  it('T1.10④ 非 raw wiki 页 → 无 wiki-raw-target 信号', async () => {
    const { workDir, userDataDir } = await setupWikiWorld()
    const r = await evaluateToolCallGate(base({
      toolName: 'write_file',
      toolInput: { path: 'llm-wiki/wiki/entities/e.md', content: 'x' },
      workDir,
      userDataDir,
      wikiConfig: wikiConfigEnabled()
    }))
    expect(r.facts.signals.some((s) => s.kind === 'wiki-raw-target')).toBe(false)
  })
})
