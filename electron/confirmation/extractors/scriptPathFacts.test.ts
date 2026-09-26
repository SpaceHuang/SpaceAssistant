import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetScriptParserServiceForTests, scriptParserService } from '../../shell/scriptParserService'
import { extractScriptPathFacts } from './scriptPathFacts'

describe('extractScriptPathFacts', () => {
  beforeAll(async () => {
    await scriptParserService.ensureInitialized()
  })

  afterAll(() => resetScriptParserServiceForTests())

  it('没有文件访问或动态执行时可标记 complete', () => {
    expect(extractScriptPathFacts('print("hello")', 'python')).toEqual({ paths: [], completeness: 'complete', dynamicAccess: false })
  })

  it('从语法树识别 open、pathlib、os 和 shutil 的静态路径参数', () => {
    const result = extractScriptPathFacts([
      'from pathlib import Path',
      'import os, shutil',
      'open("/tmp/report.txt", "r")',
      'Path("./notes.txt").read_text()',
      'os.remove("./old.txt")',
      'shutil.copy("./a", "./b")'
    ].join('\n'), 'python')
    expect(result).toEqual({ paths: ['/tmp/report.txt', './notes.txt', './old.txt', './a', './b'], completeness: 'complete', dynamicAccess: false })
  })

  it('任何动态文件路径、别名调用或进程执行都 unknown，并保留可静态提取目标', () => {
    expect(extractScriptPathFacts('open("/tmp/static")\nopen(target)', 'python')).toMatchObject({ paths: ['/tmp/static'], completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('from os import remove as rm\nrm(target)', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('import subprocess\nsubprocess.run(command, shell=True)', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('eval(source)', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it('静态可解析的 API 导入别名按原始 API 提取目标', () => {
    expect(extractScriptPathFacts('from os import remove as rm\nrm("./old.txt")', 'python')).toEqual({ paths: ['./old.txt'], completeness: 'complete', dynamicAccess: false })
    expect(extractScriptPathFacts('import subprocess as sp\nsp.run("echo ok")', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it('语法错误及不支持的语言 fail-closed', () => {
    expect(extractScriptPathFacts('open("/tmp/x"', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('const = ;', 'javascript')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it.each(['javascript', 'typescript'] as const)('%s AST 提取 fs 与 fs.promises 的静态路径', (language) => {
    const code = [
      "import * as fs from 'node:fs'",
      "import { readFile as read, writeFile } from 'node:fs/promises'",
      "fs.readFileSync('/etc/hosts', 'utf8')",
      "read('./notes.txt')",
      "writeFile('/tmp/out.txt', 'data')"
    ].join('\n')
    expect(extractScriptPathFacts(code, language)).toEqual({
      paths: ['/etc/hosts', './notes.txt', '/tmp/out.txt'], completeness: 'complete', dynamicAccess: false
    })
  })

  it('JavaScript/TypeScript 动态路径、未知调用和 child_process 一律 unknown', () => {
    expect(extractScriptPathFacts("import fs from 'fs'; fs.readFileSync(target)", 'javascript')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts("import { exec } from 'node:child_process'; exec('whoami')", 'typescript')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('customApi()', 'javascript')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it('JavaScript/TypeScript 对导入绑定的重写和延迟函数体 fail-closed', () => {
    expect(extractScriptPathFacts("import * as fs from 'node:fs'; fs = custom; fs.readFileSync('/secret')", 'javascript'))
      .toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts("import * as fs from 'node:fs'; const read = () => fs.readFileSync('/secret')", 'typescript'))
      .toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it('PowerShell 提取文件 cmdlet 静态路径，进程和动态访问 unknown', () => {
    expect(extractScriptPathFacts("Get-Content -LiteralPath 'C:\\secrets\\key.txt'", 'powershell')).toEqual({ paths: ['C:\\secrets\\key.txt'], completeness: 'complete', dynamicAccess: false })
    expect(extractScriptPathFacts("Remove-Item -Path $target; Start-Process 'cmd.exe'", 'powershell')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it('解析服务未就绪时 fail-closed', () => {
    resetScriptParserServiceForTests()
    expect(extractScriptPathFacts('open("/tmp/x")', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })
})
