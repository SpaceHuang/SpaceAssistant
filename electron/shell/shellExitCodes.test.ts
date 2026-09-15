import { describe, expect, it } from 'vitest'
import { describeExitCode, describeExitCodeDetails, describeHresult } from './shellExitCodes'

describe('shellExitCodes', () => {
  it('maps common codes', () => {
    expect(describeExitCode(127)).toMatch(/未找到/)
    expect(describeExitCode(0)).toBeUndefined()
  })

  it('T16 事故码 0xFFFF0000 给出结构化语义与可执行建议', () => {
    const details = describeExitCodeDetails(4294901760)
    expect(details?.family).toBe('windows-host')
    expect(details?.semantics).toBe('WINDOWS_HOST_INIT_FAILED')
    expect(details?.signed).toBe(-65536)
    expect(details?.hint).toContain('0xFFFF0000')
    expect(details?.advice?.join(' ')).toContain('run_script')
  })

  it('T16 非法 EncodedCommand 与 Ctrl+C 有独立语义', () => {
    expect(describeExitCodeDetails(0xfffd0000)?.semantics).toBe('WINDOWS_ENCODED_COMMAND_INVALID')
        expect(describeExitCodeDetails(4294836224)?.semantics).toBe('WINDOWS_ENCODED_COMMAND_INVALID')
    expect(describeExitCodeDetails(3221225786)?.semantics).toBe('STATUS_CONTROL_C_EXIT')
  })

  it('T16 未收录的 Windows 宿主码只标 unknown-windows-host，不编造解释', () => {
    const details = describeExitCodeDetails(3221225999)
    expect(details?.family).toBe('unknown-windows-host')
    expect(details?.advice).toBeUndefined()
    expect(details?.hint).toMatch(/Windows 宿主异常终止/)
  })

  it('HRESULT 文本解释命中 0x8009001D', () => {
    expect(describeHresult('返回错误 8009001d。')?.name).toBe('NTE_PROVIDER_DLL_FAIL')
    expect(describeHresult('常规错误')).toBeUndefined()
  })
})
