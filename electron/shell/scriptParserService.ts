// P0-T3：脚本安全解析服务（web-tree-sitter）。
// 同步/异步阻抗决策（§2.3）：初始化前置到应用启动（main.ts app ready 阶段 fire-and-forget），
// 且三语法在初始化时全量加载（非懒加载）——消除「懒加载 × 同步 parse」的首次调用窗口；
// 运行期 parse 为同步调用，未就绪/失败时返回 not_initialized（等价 A-fail → ask，fail-closed）。
import path from 'path'
import fs from 'fs'
import { Parser, Language, Tree } from 'web-tree-sitter'

export type ScriptParserLanguage = 'python' | 'bash' | 'powershell'

export type ParseOutcome =
  | { ok: true; tree: Tree }
  | { ok: false; reason: 'not_initialized' | 'parse_error'; detail?: string }

export type ScriptParserStatus = {
  ready: boolean
  failedReason?: string
  notReadyParseCount: number
}

export type ResolveTreeSitterPathOptions = {
  packaged?: boolean
  resourcesPath?: string
  developmentRoot?: string
}

// 三语法 grammar wasm 文件名（vendor 于 resources/tree-sitter/，哈希受 SHA256SUMS.txt 管控）
const LANGUAGE_WASM_FILES: ReadonlyArray<readonly [ScriptParserLanguage, string]> = [
  ['python', 'tree-sitter-python.wasm'],
  ['bash', 'tree-sitter-bash.wasm'],
  ['powershell', 'tree-sitter-powershell.wasm']
]

const CORE_WASM_FILE = 'web-tree-sitter.wasm'

type ServiceState = {
  parsers: Map<ScriptParserLanguage, Parser>
  ready: boolean
  failedReason?: string
  notReadyParseCount: number
  initPromise: Promise<void> | null
  wasmDirOverride: string | null
  notReadyWarned: boolean
}

/** 初始化失败告警钩子（P0-T4：main.ts 绑定 → logAgentEvent('error', 'treesitter.init.failed')）。 */
export type InitFailureListener = (info: { event: 'treesitter.init.failed'; failedReason: string }) => void
/** not_initialized 降级告警钩子（每会话首次，P0-T4：绑定 → logAgentEvent('warn', 'treesitter.parse.not_ready')）。 */
export type NotReadyParseListener = (info: { language: ScriptParserLanguage; notReadyParseCount: number }) => void

function createInitialState(): ServiceState {
  return {
    parsers: new Map(),
    ready: false,
    failedReason: undefined,
    notReadyParseCount: 0,
    initPromise: null,
    wasmDirOverride: null,
    notReadyWarned: false
  }
}

let state: ServiceState = createInitialState()
let initFailureListener: InitFailureListener | null = null
let notReadyParseListener: NotReadyParseListener | null = null

export function setInitFailureListener(listener: InitFailureListener | null): void {
  initFailureListener = listener
}

export function setNotReadyParseListener(listener: NotReadyParseListener | null): void {
  notReadyParseListener = listener
}

// 开发态：源码形态（vitest 下 __dirname = <repo>/electron/shell）与编译形态
// （<repo>/dist-electron/electron/shell）层级差一，逐级向上探测受控目录
// （以 SHA256SUMS.txt 为标志），两级形态统一收敛。
function developmentTreeSitterDir(): string {
  let dir = __dirname
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'resources', 'tree-sitter')
    try {
      if (fs.existsSync(path.join(candidate, 'SHA256SUMS.txt'))) return candidate
    } catch {
      // 探测失败继续向上一级
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(developmentRootDefault(), 'resources', 'tree-sitter')
}

function developmentRootDefault(): string {
  return path.resolve(__dirname, '..', '..', '..')
}

export function resolveTreeSitterWasmPath(fileName: string, options?: ResolveTreeSitterPathOptions): string {
  if (state.wasmDirOverride) return path.join(state.wasmDirOverride, fileName)
  if (options?.packaged && options.resourcesPath) {
    return path.join(options.resourcesPath, 'tree-sitter', fileName)
  }
  if (!options) {
    // 运行时形态（无显式 options）：打包态 process.resourcesPath 优先，受控目录可达才采用
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resourcesPath) {
      const candidate = path.join(resourcesPath, 'tree-sitter', fileName)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        // 探测失败按不可达处理，走开发态回退
      }
    }
  }
  const root = options?.developmentRoot
  if (root) return path.join(root, 'resources', 'tree-sitter', fileName)
  return path.join(developmentTreeSitterDir(), fileName)
}

async function loadAll(): Promise<void> {
  const coreWasmPath = resolveTreeSitterWasmPath(CORE_WASM_FILE)
  // 0.27.0 实测支持 locateFile 重载（P0-T1 probe 已验证），核心运行时统一从受控 vendor 目录加载
  await Parser.init({ locateFile: () => coreWasmPath })
  for (const [lang, fileName] of LANGUAGE_WASM_FILES) {
    const language = await Language.load(resolveTreeSitterWasmPath(fileName))
    const parser = new Parser()
    parser.setLanguage(language)
    state.parsers.set(lang, parser)
  }
}

export async function ensureInitialized(): Promise<void> {
  if (state.ready) return
  if (state.initPromise) return state.initPromise
  const promise = loadAll().then(() => {
    state.ready = true
    state.failedReason = undefined
  })
  state.initPromise = promise
  try {
    await promise
  } catch (err) {
    // 失败保留 failedReason 供诊断；释放 initPromise 允许后续显式重试
    state.initPromise = null
    state.failedReason = err instanceof Error ? err.message : String(err)
    try {
      initFailureListener?.({ event: 'treesitter.init.failed', failedReason: state.failedReason })
    } catch {
      // 告警钩子自身失败不影响失败语义
    }
    for (const parser of state.parsers.values()) {
      try {
        parser.delete()
      } catch {
        // 部分初始化阶段的清理失败不影响失败语义
      }
    }
    state.parsers.clear()
    throw err
  }
}

export function parse(language: ScriptParserLanguage, source: string): ParseOutcome {
  if (!state.ready) {
    state.notReadyParseCount += 1
    // 每会话首次：告警只刷写一次（§3 不变量 8，避免静默永久退化淹没在噪声里），计数持续递增供诊断
    if (!state.notReadyWarned) {
      state.notReadyWarned = true
      try {
        notReadyParseListener?.({ language, notReadyParseCount: state.notReadyParseCount })
      } catch {
        // 告警钩子自身失败不影响兜底语义
      }
    }
    return { ok: false, reason: 'not_initialized' }
  }
  const parser = state.parsers.get(language)
  if (!parser) {
    state.notReadyParseCount += 1
    return { ok: false, reason: 'not_initialized' }
  }
  let tree: Tree | null
  try {
    tree = parser.parse(source)
  } catch (err) {
    return { ok: false, reason: 'parse_error', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!tree || tree.rootNode.hasError) {
    // hasError 覆盖 ERROR 与 MISSING 两类节点（§3 不变量 1(b)）
    try {
      tree?.delete()
    } catch {
      // 忽略释放失败
    }
    return { ok: false, reason: 'parse_error' }
  }
  return { ok: true, tree }
}

export function getStatus(): ScriptParserStatus {
  return {
    ready: state.ready,
    failedReason: state.failedReason,
    notReadyParseCount: state.notReadyParseCount
  }
}

// 启动自检探针样本（P0-T4）：三语言各一条最小合法样本，语法树必须可解析
const SELF_CHECK_SAMPLES: ReadonlyArray<readonly [ScriptParserLanguage, string]> = [
  ['python', 'x = 1\n'],
  ['bash', 'echo ok\n'],
  ['powershell', 'Write-Output ok\n']
]

/** 启动自检：初始化就绪后对三语言各解析一条探针样本，任一失败即抛错（调用方记 treesitter.selfcheck.failed）。 */
export async function runSelfCheck(): Promise<void> {
  if (!state.ready) {
    throw new Error(state.failedReason ? `parser not ready: ${state.failedReason}` : 'parser not initialized')
  }
  for (const [language, source] of SELF_CHECK_SAMPLES) {
    const outcome = parse(language, source)
    if (outcome.ok) {
      try {
        outcome.tree.delete()
      } catch {
        // 释放失败不代表自检失败
      }
      continue
    }
    if (outcome.reason === 'not_initialized') {
      throw new Error(`selfcheck parse returned not_initialized for ${language}`)
    }
    throw new Error(`selfcheck probe failed to parse for ${language}`)
  }
}

/** 仅供测试：重置全部服务状态（含已加载的 wasm 运行时引用）。 */
export function resetScriptParserServiceForTests(): void {
  for (const parser of state.parsers.values()) {
    try {
      parser.delete()
    } catch {
      // 忽略清理失败
    }
  }
  state = createInitialState()
}

/** 仅供测试：注入不存在的 wasm 目录以模拟初始化失败。 */
export function setWasmDirOverrideForTests(dir: string | null): void {
  state.wasmDirOverride = dir
}

export const scriptParserService = {
  ensureInitialized,
  parse,
  getStatus,
  runSelfCheck
}
