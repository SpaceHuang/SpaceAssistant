import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { arch, release, type as osType } from 'os'
import { z } from 'zod'
import type { CapabilityContext, CapabilityDescriptor, ProbeOutcome } from '../types'

/** WSL / 开发环境探测缓存 TTL（需求 §6：探测类缓存 10min） */
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000
const WSL_PROBE_TIMEOUT_MS = 2_000
const DEV_PROBE_TIMEOUT_MS = 3_000

export interface EnvHandlerDeps {
  /** OS 类型（Node os.type()：Windows_NT / Linux / Darwin）；测试注入 */
  osType: () => string
  /** 文件存在性（WSL 探测用）；测试注入 */
  fileExists: (path: string) => boolean
}

const defaultDeps: EnvHandlerDeps = {
  osType: () => osType(),
  fileExists: (path) => existsSync(path)
}


interface CacheEntry {
  expiresAt: number
  value: unknown
}

/** 模块级探测缓存；测试用 clearEnvCapabilityCacheForTest 重置 */
const probeCache = new Map<string, CacheEntry>()

export function clearEnvCapabilityCacheForTest(): void {
  probeCache.clear()
}

async function cachedProbe(key: string, compute: () => Promise<unknown>): Promise<unknown> {
  const hit = probeCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = await compute()
  probeCache.set(key, { expiresAt: Date.now() + PROBE_CACHE_TTL_MS, value })
  return value
}

/** 参数数组 spawn（禁 shell 字符串拼接）；命令不存在返回 null。超时/被信号杀死时 code 为 null（评审 S1：不得误判为 0）。 */
export async function runProbe(command: string[], timeoutMs: number): Promise<ProbeOutcome | null> {
  return new Promise((resolve) => {
    execFile(
      command[0]!,
      command.slice(1),
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const errno = (error as NodeJS.ErrnoException | null)?.code
        if (errno === 'ENOENT') {
          resolve(null)
          return
        }
        if (error) {
          // 超时（killed，code=null）/非零退出：code 只在数字时透传，其余归 null（探测失败）
          resolve({
            code: typeof errno === 'number' ? errno : null,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? '')
          })
          return
        }
        resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    ).on('error', () => resolve(null))
  })
}

const firstLine = (s: string): string => s.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''

// ---------------------------------------------------------------- env.agent

const agentCapability: CapabilityDescriptor = {
  id: 'env.agent',
  family: 'env',
  summary: '当前 Agent 自身信息：产品名称、版本、形态、是否支持用户交互、产品语言',
  keywords: ['产品', '版本', '自身', 'agent', 'assistant', 'version', '产品信息', '你是谁'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{ }；无参数',
  returnsDoc: '{ productName, productVersion, form, supportsUserInteraction, productLanguage }',
  risk: 'read',
  notes: ['form 固定为 desktop（桌面应用，支持确认弹窗等用户交互）'],
  handler: async (_params, ctx) => ({
    productName: ctx.productName ?? 'SpaceAssistant',
    productVersion: ctx.productVersion ?? '',
    form: 'desktop',
    supportsUserInteraction: true,
    productLanguage: ctx.locale ?? ''
  })
}

// --------------------------------------------------------------- env.system

const WSL_EXE_PATH = 'C:\\Windows\\System32\\wsl.exe'

const systemCapability: CapabilityDescriptor = {
  id: 'env.system',
  family: 'env',
  summary: '获取宿主操作系统类型/版本/架构/系统语言，以及是否安装 WSL（仅 Windows）',
  keywords: ['系统', '操作系统', 'windows', 'linux', 'wsl', 'os', '架构', '系统语言'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{ }；无参数',
  returnsDoc: '{ os, osVersion, arch, systemLanguage, wsl: { installed, version? } }',
  risk: 'read',
  notes: ['探测结果缓存 10 分钟（进程级共享，跨会话；无 force 参数）'],
  handler: makeSystemHandler(defaultDeps)
}

async function detectSystemLanguage(os: string, handlerDeps: EnvHandlerDeps, ctx: CapabilityContext): Promise<string> {
  if (os === 'Windows_NT') {
    const probe = ctx.runProbe ?? runProbe
    const out = await probe(['powershell', '-NoProfile', '-Command', '(Get-Culture).Name'], WSL_PROBE_TIMEOUT_MS)
    return out?.stdout.trim() || ''
  }
  return process.env.LANG ?? process.env.LC_ALL ?? ''
}

async function detectWsl(
  os: string,
  handlerDeps: EnvHandlerDeps,
  ctx: CapabilityContext
): Promise<{ installed: boolean; version?: string }> {
  if (os !== 'Windows_NT') return { installed: false }
  if (!handlerDeps.fileExists(WSL_EXE_PATH)) return { installed: false }
  const probe = ctx.runProbe ?? runProbe
  const out = await probe(['wsl', '--status'], WSL_PROBE_TIMEOUT_MS)
  if (!out || out.code !== 0) return { installed: false }
  return { installed: true, version: firstLine(out.stdout) || firstLine(out.stderr) || undefined }
}


/** system handler 工厂：deps 经闭包注入，测试 overrides 不污染模块级单例（评审建议 6）。 */
function makeSystemHandler(handlerDeps: EnvHandlerDeps) {
  return async (_params: unknown, ctx: CapabilityContext) =>
    cachedProbe('env.system', async () => {
      const os = handlerDeps.osType()
      return {
        os,
        osVersion: release(),
        arch: arch(),
        systemLanguage: await detectSystemLanguage(os, handlerDeps, ctx),
        wsl: await detectWsl(os, handlerDeps, ctx)
      }
    })
}
// ----------------------------------------------------------------- env.dev

const DEV_TOOLS: Array<{ key: string; candidates: string[][] }> = [
  { key: 'node', candidates: [['node', '--version']] },
  { key: 'python', candidates: [['python3', '--version'], ['py', '--version'], ['python', '--version']] },
  { key: 'git', candidates: [['git', '--version']] }
]

const devCapability: CapabilityDescriptor = {
  id: 'env.dev',
  summary: '探测开发环境：node/python（含 python3/py 回退）/git 的可用性与版本',
  family: 'env',
  keywords: ['开发环境', 'node', 'python', 'git', '版本', 'dev', '环境', '已安装'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{ }；无参数',
  returnsDoc: '{ node: { available, version? }, python: { available, version?, resolvedAs? }, git: { available, version? } }',
  risk: 'read',
  notes: ['探测结果缓存 10 分钟（进程级共享，跨会话；无 force 参数）'],
  handler: async (_params, ctx) =>
    cachedProbe('env.dev', async () => {
      const probe = ctx.runProbe ?? runProbe
      const out: Record<string, unknown> = {}
      for (const tool of DEV_TOOLS) {
        let result: { available: boolean; version?: string; resolvedAs?: string } | undefined
        for (const candidate of tool.candidates) {
          const probeOut = await probe(candidate, DEV_PROBE_TIMEOUT_MS)
          if (probeOut && probeOut.code === 0 && probeOut.stdout.trim()) {
            result = { available: true, version: firstLine(probeOut.stdout), resolvedAs: candidate[0] }
            break
          }
        }
        out[tool.key] = result ?? { available: false }
      }
      return out
    })
}

// ----------------------------------------------------------- env.workspace

const workspaceCapability: CapabilityDescriptor = {
  id: 'env.workspace',
  family: 'env',
  summary: '获取当前会话的工作目录地址与已配置的工作目录列表（与 list_work_dirs 同数据源口径）',
  keywords: ['工作目录', '目录', 'workspace', '当前目录', '路径'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{ }；无参数',
  returnsDoc: '{ workDir, profiles?: [{ id, name, path, isBound, isDefault }] }',
  risk: 'read',
  handler: async (_params, ctx) => {
    const manager = ctx.workDirManager as
      | {
          listProfiles(): Array<{ id: string; name: string; path: string; isDefault?: boolean }>
          getActiveProfileId(): string | undefined
          getActiveWorkDir?(): string
        }
      | undefined
    if (!manager || typeof manager.listProfiles !== 'function') {
      return { workDir: ctx.workDir }
    }
    const activeProfileId = manager.getActiveProfileId()
    const activeWorkDir = manager.getActiveWorkDir?.()
    return {
      workDir: activeWorkDir || ctx.workDir,
      profiles: manager.listProfiles().map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        isBound: p.id === activeProfileId || p.path === ctx.workDir,
        isDefault: Boolean(p.isDefault)
      }))
    }
  }
}

// --------------------------------------------------------------- env.time

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function utcOffsetString(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

const timeCapability: CapabilityDescriptor = {
  id: 'env.time',
  family: 'env',
  summary: '获取当前时间：本地日期时间、时区、UTC 偏移、ISO 8601、星期（按产品语言本地化）',
  keywords: ['时间', '日期', '几点', 'today', 'time', '现在', '星期', '时区'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{ }；无参数',
  returnsDoc: '{ local, timezone, utcOffset, iso, weekday }',
  risk: 'read',
  handler: async (_params, ctx) => {
    const now = new Date()
    return {
      local: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
      utcOffset: utcOffsetString(now),
      iso: now.toISOString(),
      weekday: new Intl.DateTimeFormat(ctx.locale || undefined, { weekday: 'long' }).format(now)
    }
  }
}

// ------------------------------------------------------ env.browserDetect

const browserDetectCapability: CapabilityDescriptor = {
  id: 'env.browserDetect',
  family: 'env',
  summary: '检测 browser 工具依赖（Stagehand、Playwright、Chromium、Node）是否就绪；修复浏览器依赖后重新检测',
  keywords: ['浏览器', 'browser', '检测', '依赖', 'playwright', 'chromium', 'browser_detect', 'browserDetect'],
  paramsSchema: z.object({ force: z.boolean().optional() }).passthrough(),
  paramsDoc: '{ "force": boolean }（可选，跳过缓存强制重新检测，默认 false）',
  returnsDoc: 'browser 依赖检测结果（canInitialize、primaryFailure 与各组件状态）',
  risk: 'read',
  notes: ['检测自带缓存；安装依赖完成后传 force=true 重新检测'],
  handler: async (params, ctx) => {
    if (!ctx.detectBrowserDependencies) {
      throw new Error('浏览器检测能力在当前上下文不可用')
    }
    const force = (params as { force?: boolean } | undefined)?.force === true
    return ctx.detectBrowserDependencies(force)
  }
}

// ------------------------------------------------------------------ 组装

/**
 * env 系列能力描述符。deps 仅测试注入（osType/fileExists）；
 * 生产使用默认实现（os 模块 + fs 存在性）。
 */
export function createEnvCapabilities(overrides?: Partial<EnvHandlerDeps>): CapabilityDescriptor[] {
  const system = overrides
    ? { ...systemCapability, handler: makeSystemHandler({ ...defaultDeps, ...overrides }) }
    : systemCapability
  return [agentCapability, system, devCapability, workspaceCapability, timeCapability, browserDetectCapability]
}
