import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

/**
 * T3.1（D9 命名不写死）：源码扫描断言——除显式白名单外，源码不得散落 'llm-wiki' 字面量。
 * 白名单（v4-N3）：常量定义处（wikiConstants.ts）/ 模板正文（wikiTemplates.ts）/ 测试 fixture /
 * i18n 文案 / 类型与默认值文件中「数据值」语义（DEFAULT_WIKI_CONFIG.rootPath 初始值）。
 * 破坏性验证：向任意白名单外源码插入 'llm-wiki' 应使本测试转红。
 */
const projectRoot = path.resolve(__dirname, '../..')

const SOURCE_ROOTS = ['electron', 'src', 'packages']

const WHITELIST_FILES = new Set([
  'src/shared/wikiConstants.ts', // 常量定义处（唯一定义点）
  'electron/wiki/wikiTemplates.ts', // 模板正文（天然含词汇）
  'electron/skills/bundled/llmWikiSkill.ts', // 内置 llm-wiki skill 正文（教学词汇路径约定，天然含词汇）
  'src/shared/domainTypes.ts', // DEFAULT_WIKI_CONFIG 默认值 / PRODUCT_BUILTIN_SKILL_NAMES 数据
  'src/shared/wikiImportPaths.ts' // 默认参数等数据值（与配置缺省一致的常量数据）
])

const ALLOWED_DIRS = ['scripts', 'docs', 'res', 'resources']

function* walk(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ALLOWED_DIRS.includes(ent.name) || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'dist-electron') continue
      yield* walk(p)
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(ent.name) && !/\.(test|spec)\.(ts|tsx)$/.test(ent.name)) {
      yield p
    }
  }
}

/** 剥离 // 行注释与 /* *\/ 块注释（保留字符串字面量——代码级字面量才受 D9 约束）。 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/[^'"`\n]*$/gm, '')
}

describe('wiki 字面量扫描（T3.1/D9）', () => {
  it('白名单外源码无 llm-wiki 散落字面量', () => {
    const offenders: string[] = []
    for (const root of SOURCE_ROOTS) {
      const absRoot = path.join(projectRoot, root)
      if (!fs.existsSync(absRoot)) continue
      for (const file of walk(absRoot)) {
        const rel = path.relative(projectRoot, file).replace(/\\/g, '/')
        if (WHITELIST_FILES.has(rel)) continue
        const content = stripComments(fs.readFileSync(file, 'utf8'))
        if (content.includes('llm-wiki')) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
