import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostTranslator, resolveI18nResourcesDir } from './hostTranslate'

const tmpDirs: string[] = []

function makeResourcesDir(files: Record<string, unknown>, locale = 'zh-CN'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'i18n-res-'))
  tmpDirs.push(dir)
  const localeDir = path.join(dir, locale)
  mkdirSync(localeDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(localeDir, `${name}.json`), JSON.stringify(content), 'utf-8')
  }
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveI18nResourcesDir(偏差 13:主进程直读渲染端 i18n 真源)', () => {
  it('开发态:真实编译布局(dist-electron/electron/i18n)向上探测命中项目根资源目录', () => {
    // P1-4 修复语义:逐级向上探测真实存在的 src/renderer/i18n/resources——
    // 用真实临时目录结构(编译输出三层深)验证探测命中
    const root = mkdtempSync(path.join(tmpdir(), 'i18n-proj-'))
    tmpDirs.push(root)
    const mainDirname = path.join(root, 'dist-electron', 'electron', 'i18n')
    const expected = path.join(root, 'src', 'renderer', 'i18n', 'resources')
    mkdirSync(expected, { recursive: true })
    expect(resolveI18nResourcesDir(false, mainDirname)).toBe(expected)
  })

  it('开发态异常布局:不抛错,路径以 src/renderer/i18n/resources 结尾(探测或回退均然)', () => {
    const result = resolveI18nResourcesDir(false, path.join('nonexistent-proj', 'dist-electron', 'electron'))
    expect(result.endsWith(path.join('src', 'renderer', 'i18n', 'resources'))).toBe(true)
  })

  it('打包态:process.resourcesPath/i18n-resources(extraResources 拷贝)', () => {
    expect(resolveI18nResourcesDir(true, 'x', 'RES')).toBe(path.join('RES', 'i18n-resources'))
  })
})

describe('createHostTranslator(宿主 translate 端口实现,偏差 13)', () => {
  it('解析命名空间键并插值', () => {
    const dir = makeResourcesDir({ menu: { file: '文件', quit: '退出 {{app}}' } })
    const translate = createHostTranslator({ resourcesDir: dir })
    expect(translate({ key: 'menu.file' })).toBe('文件')
    expect(translate({ key: 'menu.quit', params: { app: 'SA' } })).toBe('退出 SA')
  })

  it('locale 切换读取对应语言目录;缺 locale 目录回退 zh-CN 真源', () => {
    const dir = makeResourcesDir({ menu: { file: '文件' } }, 'zh-CN')
    const enDir = path.join(dir, 'en-US')
    mkdirSync(enDir, { recursive: true })
    writeFileSync(path.join(enDir, 'menu.json'), JSON.stringify({ file: 'File' }), 'utf-8')
    expect(createHostTranslator({ resourcesDir: dir, locale: 'en-US' })({ key: 'menu.file' })).toBe('File')
    expect(createHostTranslator({ resourcesDir: dir, locale: 'zh-CN' })({ key: 'menu.file' })).toBe('文件')
    // fr-FR 无目录 → 回退 zh-CN
    expect(createHostTranslator({ resourcesDir: dir, locale: 'fr-FR' })({ key: 'menu.file' })).toBe('文件')
  })

  it('缺键/资源不可达:退化显示键名,不抛错不阻塞', () => {
    const dir = makeResourcesDir({ menu: { file: '文件' } })
    const translate = createHostTranslator({ resourcesDir: dir })
    expect(translate({ key: 'menu.nope' })).toBe('menu.nope')
    expect(translate({ key: 'nose.nope' })).toBe('nose.nope')
    const missing = createHostTranslator({ resourcesDir: path.join(dir, 'absent') })
    expect(missing({ key: 'menu.file' })).toBe('menu.file')
  })
})
