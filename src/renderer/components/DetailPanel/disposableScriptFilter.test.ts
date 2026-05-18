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

  // 规则 3：Agent 一次性脚本命名
  it('过滤 script_ 前缀脚本', () => {
    expect(isDisposableScript('script_fix_imports.py')).toBe(true)
    expect(isDisposableScript('src/script_helper.sh')).toBe(true)
  })

  it('过滤 run_ 前缀脚本', () => {
    expect(isDisposableScript('run_migrate.py')).toBe(true)
  })

  it('过滤 fix_ 前缀脚本', () => {
    expect(isDisposableScript('fix_bug.py')).toBe(true)
  })

  it('过滤 patch_ 前缀脚本', () => {
    expect(isDisposableScript('patch_config.py')).toBe(true)
  })

  it('过滤 migrate_ 前缀脚本', () => {
    expect(isDisposableScript('migrate_db.py')).toBe(true)
  })

  it('过滤 convert_ 前缀脚本', () => {
    expect(isDisposableScript('convert_csv.py')).toBe(true)
  })

  it('过滤 process_ 前缀脚本', () => {
    expect(isDisposableScript('process_data.py')).toBe(true)
  })

  it('过滤 generate_ 前缀脚本', () => {
    expect(isDisposableScript('generate_report.py')).toBe(true)
  })

  it('过滤 setup_ 前缀脚本', () => {
    expect(isDisposableScript('setup_env.py')).toBe(true)
  })

  // 规则 4：根/一级目录下的简短 Python 脚本
  it('过滤根目录下的简短 .py 文件', () => {
    expect(isDisposableScript('helper.py')).toBe(true)
    expect(isDisposableScript('utils/process.py')).toBe(true)
  })

  it('不过滤项目入口文件（白名单）', () => {
    expect(isDisposableScript('app.py')).toBe(false)
    expect(isDisposableScript('main.py')).toBe(false)
    expect(isDisposableScript('server.py')).toBe(false)
    expect(isDisposableScript('manage.py')).toBe(false)
    expect(isDisposableScript('wsgi.py')).toBe(false)
    expect(isDisposableScript('asgi.py')).toBe(false)
    expect(isDisposableScript('conftest.py')).toBe(false)
    expect(isDisposableScript('setup.py')).toBe(false)
    expect(isDisposableScript('__init__.py')).toBe(false)
    expect(isDisposableScript('__main__.py')).toBe(false)
  })

  it('不过滤深层目录下的 .py 文件', () => {
    expect(isDisposableScript('src/app/models.py')).toBe(false)
    expect(isDisposableScript('a/b/c/file.py')).toBe(false)
  })

  it('不过滤项目正常文件', () => {
    expect(isDisposableScript('src/index.ts')).toBe(false)
    expect(isDisposableScript('package.json')).toBe(false)
    expect(isDisposableScript('README.md')).toBe(false)
    expect(isDisposableScript('components/App.tsx')).toBe(false)
  })

  it('不过滤一级子目录下的白名单文件', () => {
    expect(isDisposableScript('app/app.py')).toBe(false)
    expect(isDisposableScript('src/main.py')).toBe(false)
  })
})