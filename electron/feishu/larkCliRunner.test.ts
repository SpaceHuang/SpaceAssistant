import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeProc = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }

const state = vi.hoisted(() => ({ proc: null as unknown, executable: '' as string | undefined }))

vi.mock('../spawnUtil', () => ({
  spawnCommandSafe: (command: string) => { state.executable = command; return { proc: state.proc } }
}))

const { LarkCliRunner } = await import('./larkCliRunner')

const MAX_OUTPUT_BYTES = 512 * 1024

function makeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = vi.fn()
  return proc
}

describe('LarkCliRunner 输出上限截断', () => {
  beforeEach(() => {
    state.proc = null
    state.executable = undefined
  })

  /**
   * MINOR（评审 v2 #8）：截断时 buildResult 不再 flush 该流，解码器里「已收到但尚未交付」的
   * 前导窗口文本会被静默丢掉。口径应与 builtinExecutors 的 ripgrep 截断一致：截断点先 flush。
   */
  it('MINOR：截断点 flush 解码器，未完成的多字节尾巴不静默丢弃', async () => {
    const proc = makeProc()
    state.proc = proc
    const runner = new LarkCliRunner(() => '/fake/lark-cli')
    const pending = runner.run({ args: ['--version'], timeoutSec: 5 })

    // 512KiB 纯 ASCII + 一个落单的 UTF-8 前导字节：写下限前已交付 ASCII，尾巴停在解码器里。
    proc.stdout.emit('data', Buffer.concat([Buffer.alloc(MAX_OUTPUT_BYTES, 0x61), Buffer.from([0xe4])]))
    proc.stderr.emit('data', Buffer.from('ok\n', 'utf8'))
    proc.emit('close', 0)

    const result = await pending
    expect(result.stdout.startsWith('a'.repeat(MAX_OUTPUT_BYTES))).toBe(true)
    expect(result.stdout.endsWith('\uFFFD\n[输出被截断]')).toBe(true)
    // 未截断的另一条流不受影响。
    expect(result.stderr).toBe('ok\n')
  })

  it('执行计划准备的 executable，即使 runner 配置随后变化', async () => {
    const proc = makeProc()
    state.proc = proc
    const runner = new LarkCliRunner(() => '/live/changed')
    const pending = runner.run({ args: ['doc', 'get'], timeoutSec: 5, resolvedExecutable: '/prepared/lark-cli' })
    expect(state.executable).toBe('/prepared/lark-cli')
    proc.emit('close', 0)
    await expect(pending).resolves.toMatchObject({ exitCode: 0 })
  })

  it('runner 启动前 signal 已 abort 时不创建 CLI 进程', async () => {
    const proc = makeProc()
    state.proc = proc
    const controller = new AbortController()
    controller.abort()
    const runner = new LarkCliRunner(() => '/fake/lark-cli')

    await expect(runner.run({ args: ['doc', 'create'], signal: controller.signal })).resolves.toMatchObject({
      cancelledBeforeStart: true, exitCode: 1, timedOut: false
    })
    expect(state.executable).toBeUndefined()
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('子进程启动后 signal abort 会请求终止并等待进程 close', async () => {
    vi.useFakeTimers()
    try {
      const proc = makeProc()
      state.proc = proc
      const controller = new AbortController()
      const runner = new LarkCliRunner(() => '/fake/lark-cli')
      const pending = runner.run({ args: ['doc', 'create'], timeoutSec: 5, signal: controller.signal })

      expect(state.executable).toBe('/fake/lark-cli')
      controller.abort()
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
      proc.emit('close', 143)
      await expect(pending).resolves.toMatchObject({ exitCode: 143, timedOut: false })
      await vi.advanceTimersByTimeAsync(500)
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })
})
