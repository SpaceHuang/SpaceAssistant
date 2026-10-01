/**
 * R6：文本搜索的范围透明——默认忽略、隐藏条目、敏感路径三类语义的唯一规划出口。
 *
 * 总原则（§4.6.1）：**默认忽略 ≠ 访问控制**。默认忽略是工具默认值，可被调用方显式意图解除
 * （显式路径点名，或 include_ignored: true）；敏感点文件（.env / .env.* / secrets/）在遍历中
 * 始终排除（include_ignored 也不解除），**显式点名该文件才搜索**且必须明示。
 * rg 与 walk 两条引擎路径共用本模块产出的规划（敏感排除模式由同一份规则生成，不得各写一份）。
 */
import fs from 'fs'
import path from 'path'

import { isSensitivePath } from '../shell/shellSensitivePaths'
import type { GrepExecArgs } from './builtinExecutors'

/**
 * 默认忽略目录（只是默认值，不是访问控制；成员与旧 GREP_SKIP_DIRS 一致，不增不减）。
 * 默认不搜索以免噪音与耗时；显式指向其内部路径，或传 include_ignored: true，即可搜索。
 */
export const GREP_DEFAULT_IGNORES: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '__pycache__',
  'dist',
  'dist-electron',
  '.cursor'
] as const

/**
 * 敏感排除的 rg glob 模式（由 isSensitivePath 的同一份规则生成——两引擎共用）。
 * 显式点名敏感文件时整组不追加（尊重明确意图），由调用方明示「命中敏感路径」。
 */
export function grepSensitiveExcludes(): string[] {
  return ['!**/.env', '!**/.env.*', '!**/.env/**', '!**/secrets/**', '!**/secrets']
}

/**
 * 浅层敏感条目统计的名称判定（§7.10「判定基准」，v3 M2 订正）：
 * 与 grepSensitiveExcludes() 的名称语义对齐——不得直接用 isSensitivePath
 * （其 secrets 判定要求两侧分隔符，对根级裸 secrets/ 不命中，而 rg 侧的反向 glob 实际排除它；
 * glob 文本此处从略（其双星加斜杠的字面序列会提前终止块注释）。
 */
function isSensitiveEntryName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || name === 'secrets'
}

export interface GrepScope {
  /** 实际搜索根（相对 workDir） */
  root: string
  engine: 'ripgrep' | 'walk'
  /**
   * 被跳过、且未命中调用方搜索范围的条目（纯范围事实，不含安全语义）。
   * kind 区分文件/目录（敏感名单混含两者，§7.10）；sensitive 为跳过原因标注（明示义务，§1.6）。
   * 原 explicit 字段已删除：其语义被「显式点名即解除（不进名单）」完整取代，全历史恒 false（§1.6 死字段）。
   */
  skipped: Array<{ name: string; kind: 'file' | 'directory'; sensitive?: boolean }>
  skippedCount: number
  /** head_limit / 超时截断 */
  truncated: boolean
  limitReason?: 'head_limit' | 'timeout' | 'output_limit'
}

export interface GrepInvocationPlan {
  /** 传给 rg 的 --hidden（显式点名隐藏成员内部或 include_ignored 时为 true） */
  hidden: boolean
  /** 默认忽略名单 glob（未解除的成员） */
  ignoreGlobs: string[]
  /** 敏感排除 glob（显式点名敏感文件时为空） */
  sensitiveExcludes: string[]
  /** 显式点名敏感路径（返回体必须明示「命中敏感路径」） */
  explicitSensitiveHit: boolean
  /** D1：ignoreGlobs/sensitiveExcludes 必须经 rg `--iglob`（大小写无关）消费，与 isSensitivePath 小写化口径同源 */
  caseInsensitiveGlobs: boolean
  /** 范围事实骨架（skipped 在执行前统计） */
  scope: GrepScope
  /** D1/G：--no-ignore-vcs 开关（设置项 grepSearchGitignored 与调用方 includeIgnored 的 OR——设置项是下限，只能放宽不能收窄） */
  noIgnoreVcs: boolean
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

// D2（评审 2026-09-28）：显式点名判定改为「searchRel 任一路径段命中成员名」——
// 旧实现只比首段，嵌套点名（sub/node_modules/pkg）会被 rg 的任意深度 glob
// （感叹号 + 两个星号 + /node_modules/ + 两个星号）静默搜空。大小写比较与文件系统一致（win32 不敏感）。
function isInsideMember(searchRel: string, name: string): boolean {
  const rel = toPosix(searchRel)
  if (!rel || rel === '.') return false
  const segments = rel.split('/')
  return segments.some((seg) => seg.toLowerCase() === name.toLowerCase())
}

/** searchRel 任一段是隐藏段（. 开头）→ rg 默认隐藏过滤会跳过目标子树 */
function hasHiddenSegment(searchRel: string): boolean {
  const rel = toPosix(searchRel)
  if (!rel || rel === '.') return false
  return rel.split('/').some((seg) => seg.startsWith('.'))
}

/**
 * 一次 grep 调用的范围规划（rg / walk 共用）。
 * 不做安全判定——这里只产「哪些目录会被跳过、隐藏过滤开不开、敏感 glob 加不加」的范围事实。
 */
export function planGrepInvocation(opts: {
  workDir: string
  searchPath: string
  args: Pick<GrepExecArgs, 'includeIgnored'> & { glob?: string }
  engine?: 'ripgrep' | 'walk'
  /** 搜索根类型：'file' 时无目录遍历语义——skipped 与 ignoreGlobs 恒空（§7.5，修复 §1.4 虚报）；缺省 'directory' */
  searchKind?: 'file' | 'directory'
  /** 设置项要求解除 gitignore（调用方的 include_ignored 为另一来源；生效语义为 OR，§7.9） */
  searchGitignored?: boolean
}): GrepInvocationPlan {
  const { workDir, searchPath, args } = opts
  const searchKind = opts.searchKind ?? 'directory'
  const searchRel = toPosix(path.relative(workDir, searchPath))
  const searchRelInsideWorkDir = Boolean(searchRel) && searchRel !== '.' && !searchRel.startsWith('..')

  // 3) 敏感路径：遍历中始终排除（include_ignored 不解除）；显式点名该文件/目录内部才搜索
  //    （提前计算：浅层敏感条目统计依赖 explicitSensitiveHit 开关，§7.10）
  const explicitSensitiveHit = searchRelInsideWorkDir && isSensitivePath(searchPath)
  const sensitiveExcludes = explicitSensitiveHit ? [] : grepSensitiveExcludes()

  // 1) 默认忽略成员：实际存在、且未命中调用方搜索范围（任一段点名即解除）→ 计入 skipped
  //    searchKind='file'：单文件根无遍历语义，不产名单 glob 与 skipped 统计（rg 的 glob 对显式文件参数本就不生效）
  const skipped: GrepScope['skipped'] = []
  const ignoreGlobs: string[] = []
  if (searchKind === 'directory') {
    for (const name of GREP_DEFAULT_IGNORES) {
      const isExplicitTarget = searchRelInsideWorkDir && isInsideMember(searchRel, name)
      if (isExplicitTarget) continue
      const exists = fs.existsSync(path.join(workDir, name))
      if (exists) skipped.push({ name, kind: 'directory' })
      // include_ignored 一并解除；显式点名只解除被点名成员
      if (!args.includeIgnored && !isExplicitTarget) {
        ignoreGlobs.push(`!**/${name}/**`)
      }
    }
    // H（§7.10）：敏感条目明示义务——对搜索根做一层浅层 readdir，命中敏感名的条目如实上报。
    // 仅 !explicitSensitiveHit 时统计（点名时条目实际被搜索，与排除 glob 同开关，名单与行为一致）；
    // 深层条目不逐条上报（D13，由「skipped items may contain matches」文案兜底）。
    if (!explicitSensitiveHit) {
      try {
        const entries = fs.readdirSync(searchPath, { withFileTypes: true })
        for (const ent of entries) {
          if (!isSensitiveEntryName(ent.name)) continue
          if (skipped.some((s) => s.name === ent.name)) continue
          skipped.push({ name: ent.name, kind: ent.isDirectory() ? 'directory' : 'file', sensitive: true })
        }
      } catch {
        // 搜索根不可读时无浅层名单可统计；范围事实由 no_match 输出的其他字段承担
      }
    }
  }

  // 2) 隐藏过滤：搜索目标子树内含任一隐藏段（含普通隐藏目录）或 include_ignored → --hidden
  const hidden = args.includeIgnored || (searchRelInsideWorkDir && hasHiddenSegment(searchRel))

  // G（D1）：搜索被 Git 忽略的路径——只追加 --no-ignore-vcs（解除 .gitignore 系），
  // 不追加 --no-ignore/-u（会连 .ignore/.rgignore 一起解除，越界，§6.5 实测选型）
  const noIgnoreVcs = Boolean(opts.searchGitignored) || Boolean(args.includeIgnored)

  return {
    hidden,
    ignoreGlobs,
    sensitiveExcludes,
    explicitSensitiveHit,
    noIgnoreVcs,
    // D1（评审 2026-09-28）：rg 侧 glob 用 --iglob（大小写无关）消费——isSensitivePath
    // 是小写化判定，大小写敏感的 `--glob` 会让 Secrets/、.ENV 变体绕过排除并进入结果。
    caseInsensitiveGlobs: true,
    scope: {
      root: !searchRel || searchRel === '.' ? '.' : toPosix(searchRel),
      engine: opts.engine ?? 'ripgrep',
      skipped,
      skippedCount: skipped.length,
      truncated: false
    }
  }
}

/** no_match 输出（R6 核心承诺：不得裸「No matches found」——必须说明实际搜索范围与跳过情况） */
export function formatGrepNoMatchOutput(scope: GrepScope): string {
  const base = `No matches found (searched: ${scope.root}`
  if (scope.skippedCount === 0) {
    return `${base})`
  }
  const names = scope.skipped
    .map((s) => (s.sensitive ? `${s.name} (sensitive, not searched)` : s.name))
    .join(', ')
  // 计数词用 items：敏感名单混含文件与目录，「directories」语义容纳不下（§7.10 H4）
  return `${base}; skipped ${scope.skippedCount} items: ${names}; skipped items may contain matches)`
}
