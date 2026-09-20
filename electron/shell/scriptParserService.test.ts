// P0-T3：ScriptParserService 单测。
// 初始化归属：采用「测试文件 beforeAll 内 await ensureInitialized()」（§2.3 归属约束二选一，
// 不写入三项目共享的 src/test/setup.ts，PR 说明同步）。
import { scriptParserService, resetScriptParserServiceForTests, resolveTreeSitterWasmPath, setWasmDirOverrideForTests } from './scriptParserService'

const PYTHON_OK = 'import os\n\ndef f(x):\n    return os.path.join(x, "y")\n\nprint(f("a"))\n'
const BASH_OK = 'echo "hello" && ls -la | grep foo\n'
const POWERSHELL_OK = 'Get-ChildItem -Path . | ForEach-Object { $_.Name }\n'

describe('scriptParserService', () => {
  describe('未初始化状态（reset 后）', () => {
    beforeEach(() => {
      resetScriptParserServiceForTests()
    })

    it('parse 返回 not_initialized 且 getStatus().notReadyParseCount 递增', () => {
      const before = scriptParserService.getStatus()
      expect(before.ready).toBe(false)
      const outcome = scriptParserService.parse('python', 'x = 1')
      expect(outcome).toEqual({ ok: false, reason: 'not_initialized' })
      const after = scriptParserService.getStatus()
      expect(after.notReadyParseCount).toBe(before.notReadyParseCount + 1)
      // bash / powershell 同样兜底
      expect(scriptParserService.parse('bash', 'echo hi').reason).toBe('not_initialized')
      expect(scriptParserService.parse('powershell', 'Get-Date').reason).toBe('not_initialized')
      expect(scriptParserService.getStatus().notReadyParseCount).toBe(before.notReadyParseCount + 3)
    })
  })

  describe('初始化后', () => {
    beforeAll(async () => {
      resetScriptParserServiceForTests()
      await scriptParserService.ensureInitialized()
    })

    it('初始化幂等：重复 await 不抛错且保持 ready', async () => {
      await scriptParserService.ensureInitialized()
      await scriptParserService.ensureInitialized()
      expect(scriptParserService.getStatus().ready).toBe(true)
    })

    it('初始化完成后三语言立即可 parse，无首调用 not_initialized 窗口', () => {
      // 全量加载语义：第一次调用即 ready，不落 not_initialized
      expect(scriptParserService.getStatus().ready).toBe(true)
      for (const [lang, code] of [
        ['python', PYTHON_OK],
        ['bash', BASH_OK],
        ['powershell', POWERSHELL_OK]
      ] as const) {
        const outcome = scriptParserService.parse(lang, code)
        expect(outcome.ok).toBe(true)
      }
      expect(scriptParserService.getStatus().notReadyParseCount).toBe(0)
    })

    it('三语言合法样本 ok:true 且语法树根节点类型正确', () => {
      const py = scriptParserService.parse('python', PYTHON_OK)
      expect(py.ok && py.tree.rootNode.type).toBe('module')
      const bash = scriptParserService.parse('bash', BASH_OK)
      expect(bash.ok && bash.tree.rootNode.type).toBe('program')
      const ps = scriptParserService.parse('powershell', POWERSHELL_OK)
      expect(ps.ok && ps.tree.rootNode.type).toBe('program')
    })

    it('Python 语法错误样本（def f(:）返回 parse_error', () => {
      const outcome = scriptParserService.parse('python', 'def f(:\n')
      expect(outcome).toEqual({ ok: false, reason: 'parse_error' })
    })

    it('Bash 未闭合引号样本返回 parse_error', () => {
      const outcome = scriptParserService.parse('bash', 'echo "unclosed')
      expect(outcome).toEqual({ ok: false, reason: 'parse_error' })
    })

    it('PowerShell 非法 token 样本（未闭合 $( / here-string）返回 parse_error', () => {
      expect(scriptParserService.parse('powershell', '$(Get-ChildItem')).toEqual({ ok: false, reason: 'parse_error' })
      expect(scriptParserService.parse('powershell', "@'\nno terminator")).toEqual({ ok: false, reason: 'parse_error' })
    })
  })

  describe('初始化失败（wasm 路径不存在）', () => {
    beforeEach(() => {
      resetScriptParserServiceForTests()
      setWasmDirOverrideForTests('Z:/nonexistent-tree-sitter-dir')
    })

    afterEach(() => {
      setWasmDirOverrideForTests(null)
    })

    it('ensureInitialized reject、getStatus().ready === false 且带 failedReason', async () => {
      await expect(scriptParserService.ensureInitialized()).rejects.toThrow()
      const status = scriptParserService.getStatus()
      expect(status.ready).toBe(false)
      expect(status.failedReason).toBeTruthy()
    })

    it('失败后 parse 保持 not_initialized 兜底（fail-closed）', async () => {
      await expect(scriptParserService.ensureInitialized()).rejects.toThrow()
      expect(scriptParserService.parse('python', 'x = 1')).toEqual({ ok: false, reason: 'not_initialized' })
    })
  })

  describe('wasm 路径双态定位', () => {
    it('resolveTreeSitterWasmPath 开发态指向仓库 resources/tree-sitter 且文件可达', () => {
      const fs = require('node:fs')
      const devPath = resolveTreeSitterWasmPath('web-tree-sitter.wasm', { packaged: false })
      expect(fs.existsSync(devPath)).toBe(true)
      expect(devPath.replace(/\\/g, '/')).toContain('resources/tree-sitter/web-tree-sitter.wasm')
    })

    it('打包态优先指向 resourcesPath 下的 tree-sitter 目录', () => {
      const p = resolveTreeSitterWasmPath('tree-sitter-python.wasm', {
        packaged: true,
        resourcesPath: '/mock/resources'
      })
      expect(p.replace(/\\/g, '/')).toBe('/mock/resources/tree-sitter/tree-sitter-python.wasm')
    })
  })

  describe('IPC 状态投影形状（treesitter:get-status，P0-T4 DoD）', () => {
    it('getStatus 返回恰好 { ready, failedReason?, notReadyParseCount } 形状', async () => {
      resetScriptParserServiceForTests()
      const before = scriptParserService.getStatus()
      expect(Object.keys(before).sort()).toEqual(['failedReason', 'notReadyParseCount', 'ready'])
      expect(before.ready).toBe(false)
      expect(before.notReadyParseCount).toBe(0)
      await scriptParserService.ensureInitialized()
      const ready = scriptParserService.getStatus()
      expect(Object.keys(ready).sort()).toEqual(['failedReason', 'notReadyParseCount', 'ready'])
      expect(ready).toEqual({ ready: true, failedReason: undefined, notReadyParseCount: 0 })
    })
  })
})
