import { describe, it, expect } from 'vitest'
import { isDisposableScript } from './disposableScriptFilter'

describe('isDisposableScript', () => {
  // 规则 1：临时目录
  it('过滤 tmp/ 目录下的文件', () => {
    expect(isDisposableScript('tmp/output.txt')).toBe(true)
    expect(isDisposableScript('tmp/sub/file.py')).toBe(true)
  })

  it('过滤 temp/ 目录下的文件', () => {
    expect(isDisposableScript('temp/cache.json')).toBe(true)
  })

  it('过滤 .tmp/ 目录下的文件', () => {
    expect(isDisposableScript('.tmp/data.txt')).toBe(true)
  })

  // 规则 2：临时前缀
  it('过滤 tmp_ 前缀文件', () => {
    expect(isDisposableScript('tmp_result.json')).toBe(true)
    expect(isDisposableScript('src/tmp_data.py')).toBe(true)
  })

  it('过滤 temp_ 前缀文件', () => {
    expect(isDisposableScript('temp_data.py')).toBe(true)
    expect(isDisposableScript('utils/temp_output.json')).toBe(true)
  })

  it('不过滤 Agent 写入的项目脚本（命名模式）', () => {
    expect(isDisposableScript('script_fix_imports.py')).toBe(false)
    expect(isDisposableScript('src/script_helper.sh')).toBe(false)
    expect(isDisposableScript('run_migrate.py')).toBe(false)
    expect(isDisposableScript('generate_report.py')).toBe(false)
    expect(isDisposableScript('helper.py')).toBe(false)
    expect(isDisposableScript('utils/process.py')).toBe(false)
  })

  it('不过滤项目正常文件', () => {
    expect(isDisposableScript('src/index.ts')).toBe(false)
    expect(isDisposableScript('package.json')).toBe(false)
    expect(isDisposableScript('README.md')).toBe(false)
    expect(isDisposableScript('components/App.tsx')).toBe(false)
    expect(isDisposableScript('app.py')).toBe(false)
    expect(isDisposableScript('src/app/models.py')).toBe(false)
  })
})
