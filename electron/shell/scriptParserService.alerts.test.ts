// P0-T4：解析服务运行期告警与降级可观测（§3 不变量 8）。
// - 模拟 wasm 路径缺失：初始化失败产生 error 日志事件（经绑定的告警钩子）且 getStatus().ready === false
// - 模拟未初始化调用 parse：首条 warn 告警产生且不重复刷写（每会话首次语义）
import {
  scriptParserService,
  resetScriptParserServiceForTests,
  setWasmDirOverrideForTests,
  setNotReadyParseListener,
  setInitFailureListener,
  runSelfCheck
} from './scriptParserService'

describe('scriptParserService 降级可观测', () => {
  describe('初始化失败告警', () => {
    const initFailures: Array<{ event: string; failedReason?: string }> = []

    beforeEach(() => {
      resetScriptParserServiceForTests()
      initFailures.length = 0
      setNotReadyParseListener(null)
      setInitFailureListener((info) => initFailures.push(info))
      setWasmDirOverrideForTests('Z:/nonexistent-tree-sitter-dir')
    })

    afterEach(() => {
      setWasmDirOverrideForTests(null)
      setInitFailureListener(null)
    })

    it('初始化失败触发 treesitter.init.failed 事件且 ready === false', async () => {
      await expect(scriptParserService.ensureInitialized()).rejects.toThrow()
      expect(initFailures).toHaveLength(1)
      expect(initFailures[0].event).toBe('treesitter.init.failed')
      expect(initFailures[0].failedReason).toBeTruthy()
      expect(scriptParserService.getStatus().ready).toBe(false)
    })
  })

  describe('自检', () => {
    beforeEach(() => {
      resetScriptParserServiceForTests()
      setNotReadyParseListener(null)
    })

    it('初始化成功后自检通过（三语言探针样本 ok）', async () => {
      await scriptParserService.ensureInitialized()
      await expect(runSelfCheck()).resolves.toBeUndefined()
    })

    it('未初始化时自检失败（fail-closed 可观测）', async () => {
      await expect(runSelfCheck()).rejects.toThrow()
    })
  })

  describe('not_initialized 运行期告警（每会话首次）', () => {
    const warnings: Array<{ language: string; notReadyParseCount: number }> = []

    beforeEach(() => {
      resetScriptParserServiceForTests()
      warnings.length = 0
      setNotReadyParseListener((info) => warnings.push(info))
    })

    afterEach(() => {
      setNotReadyParseListener(null)
    })

    it('首条 not_initialized 触发 warn，后续调用不重复刷写', () => {
      scriptParserService.parse('python', 'x = 1')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toEqual({ language: 'python', notReadyParseCount: 1 })

      scriptParserService.parse('bash', 'echo hi')
      scriptParserService.parse('powershell', 'Get-Date')
      expect(warnings).toHaveLength(1)
      // 计数器持续递增（诊断面），但告警不再刷写
      expect(scriptParserService.getStatus().notReadyParseCount).toBe(3)
    })

    it('初始化成功后的 parse 不触发告警', async () => {
      await scriptParserService.ensureInitialized()
      scriptParserService.parse('python', 'x = 1')
      expect(warnings).toHaveLength(0)
    })
  })
})
