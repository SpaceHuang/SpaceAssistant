import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeProc = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }

const state = vi.hoisted(() => ({ proc: null as unknown }))

vi.mock('../spawnUtil', () => ({
  spawnCommandSafe: () => ({ proc: state.proc })
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
})