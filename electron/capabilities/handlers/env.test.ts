import { describe, expect, it } from 'vitest'
import { createEnvCapabilities, clearEnvCapabilityCacheForTest } from './env'
import type { CapabilityContext, ProbeOutcome } from '../types'

interface FakeProbe {
  runs: Array<{ command: string[]; timeoutMs: number }>
  respond: (command: string[]) => ProbeOutcome | null
}

function fakeProbe(respond: (command: string[]) => ProbeOutcome | null): FakeProbe {
  return { runs: [], respond(command) { return respond(command) } }
}

function makeCtx(overrides?: Partial<CapabilityContext> & { probe?: FakeProbe }): CapabilityContext {
  return {
    workDir: 'C:\\work',
    userDataDir: 'C:\\user',
    sessionId: 's1',
    requestId: 'r1',
    signal: new AbortController().signal,
    productName: 'SpaceAssistant',
    productVersion: '0.1.8',
    locale: 'zh-CN',
    ...(overrides?.probe
      ? {
          runProbe: async (command: string[], timeoutMs: number) => {
            overrides.probe!.runs.push({ command, timeoutMs })
            return overrides.probe!.respond(command)
          }
        }
      : {}),
    ...overrides
  } as CapabilityContext
}

function findCap(caps: ReturnType<typeof createEnvCapabilities>, id: string) {
  const cap = caps.find((c) => c.id === id)
  if (!cap) throw new Error(`missing capability ${id}`)
  return cap
}

describe('env.agent', () => {
  it('返回产品名称/版本/形态/交互能力/语言', async () => {
    const cap = findCap(createEnvCapabilities(), 'env.agent')
    const data = (await cap.handler({}, makeCtx())) as Record<string, unknown>
    expect(data).toEqual({
      productName: 'SpaceAssistant',
      productVersion: '0.1.8',
      form: 'desktop',
      supportsUserInteraction: true,
      productLanguage: 'zh-CN'
    })
  })
})

describe('env.system', () => {
  it('Windows + wsl.exe 存在 + wsl --status 成功 → wsl.installed=true', async () => {
    clearEnvCapabilityCacheForTest()
    const probe = fakeProbe((command) =>
      command[0] === 'wsl' ? { code: 0, stdout: '默认分发: Ubuntu', stderr: '' } : null
    )
    const cap = findCap(
      createEnvCapabilities({ osType: () => 'Windows_NT', fileExists: (p) => p.endsWith('wsl.exe') }),
      'env.system'
    )
    const data = (await cap.handler({}, makeCtx({ probe }))) as { wsl: { installed: boolean; version?: string } }
    expect(data.wsl.installed).toBe(true)
    expect(probe.runs.some((r) => r.command[0] === 'wsl' && r.timeoutMs === 2000)).toBe(true)
  })

  it('Windows + wsl.exe 不存在 → 不触发 wsl 探测，installed=false', async () => {
    clearEnvCapabilityCacheForTest()
    const probe = fakeProbe(() => null)
    const cap = findCap(
      createEnvCapabilities({ osType: () => 'Windows_NT', fileExists: () => false }),
      'env.system'
    )
    const data = (await cap.handler({}, makeCtx({ probe }))) as { wsl: { installed: boolean } }
    expect(data.wsl.installed).toBe(false)
    expect(probe.runs.filter((r) => r.command[0] === 'wsl')).toHaveLength(0)
  })

  it('非 Windows 恒 wsl.installed=false 且不探测', async () => {
    clearEnvCapabilityCacheForTest()
    const probe = fakeProbe(() => null)
    const cap = findCap(createEnvCapabilities({ osType: () => 'Linux', fileExists: () => true }), 'env.system')
    const data = (await cap.handler({}, makeCtx({ probe }))) as { wsl: { installed: boolean } }
    expect(data.wsl.installed).toBe(false)
    expect(probe.runs.filter((r) => r.command[0] === 'wsl')).toHaveLength(0)
  })

  it('结果缓存 10 分钟：第二次调用不再探测', async () => {
    clearEnvCapabilityCacheForTest()
    let calls = 0
    const probe = fakeProbe((command) => {
      if (command[0] === 'wsl') {
        calls += 1
        return { code: 0, stdout: 'ok', stderr: '' }
      }
      return null
    })
    const cap = findCap(
      createEnvCapabilities({ osType: () => 'Windows_NT', fileExists: () => true }),
      'env.system'
    )
    const ctx = makeCtx({ probe })
    await cap.handler({}, ctx)
    await cap.handler({}, ctx)
    expect(calls).toBe(1)
  })
})

describe('env.dev', () => {
  it('可用工具返回版本；未装工具返回 available:false 而非报错', async () => {
    clearEnvCapabilityCacheForTest()
    const probe = fakeProbe((command) => {
      const cmd = command[0]
      if (cmd === 'node') return { code: 0, stdout: 'v20.11.0', stderr: '' }
      if (cmd === 'python3') return { code: 0, stdout: 'Python 3.12.1', stderr: '' }
      return null // git 未装
    })
    const cap = findCap(createEnvCapabilities({ osType: () => 'Linux' }), 'env.dev')
    const data = (await cap.handler({}, makeCtx({ probe }))) as {
      node: { available: boolean; version?: string }
      python: { available: boolean; resolvedAs?: string }
      git: { available: boolean }
    }
    expect(data.node).toEqual({ available: true, version: 'v20.11.0', resolvedAs: 'node' })
    expect(data.python.available).toBe(true)
    expect(data.python.resolvedAs).toBe('python3')
    expect(data.git).toEqual({ available: false })
    expect(probe.runs.every((r) => r.timeoutMs === 3000)).toBe(true)
  })

  it('python3 未装时回退 py 再回退 python', async () => {
    clearEnvCapabilityCacheForTest()
    const probe = fakeProbe((command) =>
      command[0] === 'py' ? { code: 0, stdout: 'Python 3.11.4', stderr: '' } : null
    )
    const cap = findCap(createEnvCapabilities({ osType: () => 'Windows_NT' }), 'env.dev')
    const data = (await cap.handler({}, makeCtx({ probe }))) as { python: { resolvedAs?: string } }
    expect(data.python.resolvedAs).toBe('py')
  })
})

describe('env.workspace', () => {
  it('返回当前工作目录；有 workDirManager 时复用其 profiles 口径', async () => {
    const cap = findCap(createEnvCapabilities(), 'env.workspace')
    const withManager = (await cap.handler(
      {},
      makeCtx({
        workDirManager: {
          listProfiles: () => [{ id: 'p1', name: 'proj', path: 'C:\\work', isDefault: true, isSensitive: false, aliases: [] }],
          getActiveProfileId: () => 'p1',
          getActiveWorkDir: () => 'C:\\work'
        }
      })
    )) as { workDir: string; profiles: Array<{ id: string; isBound: boolean }> }
    expect(withManager.workDir).toBe('C:\\work')
    expect(withManager.profiles[0]!.isBound).toBe(true)
  })
})

describe('env.time', () => {
  it('返回本地时间/时区/UTC 偏移/ISO/本地化星期', async () => {
    const cap = findCap(createEnvCapabilities(), 'env.time')
    const data = (await cap.handler({}, makeCtx())) as {
      iso: string
      timezone: string
      utcOffset: string
      weekday: string
      local: string
    }
    expect(new Date(data.iso).getTime()).not.toBeNaN()
    expect(data.timezone).toBeTruthy()
    expect(data.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/)
    expect(data.weekday.length).toBeGreaterThan(0)
    expect(data.local).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('env.browserDetect', () => {
  it('透传 force 参数到检测缝', async () => {
    const cap = findCap(createEnvCapabilities(), 'env.browserDetect')
    const seen: boolean[] = []
    const data = (await cap.handler(
      { force: true },
      makeCtx({ detectBrowserDependencies: async (force) => { seen.push(force); return { canInitialize: true } } })
    )) as { canInitialize: boolean }
    expect(seen).toEqual([true])
    expect(data.canInitialize).toBe(true)
  })

  it('检测缝缺失时返回明确错误', async () => {
    const cap = findCap(createEnvCapabilities(), 'env.browserDetect')
    await expect(cap.handler({}, makeCtx())).rejects.toThrow('浏览器检测')
  })
})
