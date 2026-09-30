import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetScriptParserServiceForTests, scriptParserService } from '../../shell/scriptParserService'
import { extractScriptPathFacts } from './scriptPathFacts'

describe('extractScriptPathFacts', () => {
  beforeAll(async () => {
    await scriptParserService.ensureInitialized()
  })

  afterAll(() => resetScriptParserServiceForTests())

  it('没有文件访问或动态执行时可标记 complete', () => {
    expect(extractScriptPathFacts('print("hello")', 'python')).toEqual({ paths: [], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: [] })
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
    expect(result).toEqual({ paths: ['/tmp/report.txt', './notes.txt', './old.txt', './a', './b'], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: [] })
  })

  it('任何动态文件路径、别名调用或进程执行都 unknown，并保留可静态提取目标', () => {
    expect(extractScriptPathFacts('open("/tmp/static")\nopen(target)', 'python')).toMatchObject({ paths: ['/tmp/static'], completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('from os import remove as rm\nrm(target)', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('import subprocess\nsubprocess.run(command, shell=True)', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('eval(source)', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it('静态可解析的 API 导入别名按原始 API 提取目标', () => {
    expect(extractScriptPathFacts('from os import remove as rm\nrm("./old.txt")', 'python')).toEqual({ paths: ['./old.txt'], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: [] })
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
      paths: ['/etc/hosts', './notes.txt', '/tmp/out.txt'], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: []
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
    expect(extractScriptPathFacts("Get-Content -LiteralPath 'C:\\secrets\\key.txt'", 'powershell')).toEqual({ paths: ['C:\\secrets\\key.txt'], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: [] })
    expect(extractScriptPathFacts("Remove-Item -Path $target; Start-Process 'cmd.exe'", 'powershell')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it('解析服务未就绪时 fail-closed', () => {
    resetScriptParserServiceForTests()
    expect(extractScriptPathFacts('open("/tmp/x")', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })
})

// ============================================================================
// P0 假阳性修复回归矩阵(docs/develop/script-path-extraction-false-positive-
// diagnosis-and-improvement-plan.md §7.1 探针矩阵转正 + §5 P0-1~P0-4)。
// 编号 fN 与方案探针矩阵对应;§10 待确认项的拍板结论在对应用例注释中标明。
// ============================================================================
describe('extractScriptPathFacts:P0 假阳性修复(探针矩阵回归)', () => {
  beforeAll(async () => {
    await scriptParserService.ensureInitialized()
  })

  afterAll(() => resetScriptParserServiceForTests())

  // ---- P0-1 路径构造器纳入折叠 ----

  it('f2 裸 os.path.join(全字面量、无 IO)不再触发 unknown', () => {
    expect(extractScriptPathFacts('import os\nos.path.join("/a", "b")', 'python')).toMatchObject({ paths: [], completeness: 'complete' })
  })

  it('f4 内层 join 折叠进 open 实参(§10-6 拍板:统一以 / 折叠,平台变体交探测归一)', () => {
    expect(extractScriptPathFacts('import os\nopen(os.path.join("d", "events.jsonl"))', 'python')).toEqual({
      paths: ['d/events.jsonl'], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: []
    })
  })

  it('os.path.dirname / basename / splitext[0] 折叠为静态路径', () => {
    expect(extractScriptPathFacts('import os\nopen(os.path.dirname("/d/sub/f.txt"))', 'python')).toMatchObject({ paths: ['/d/sub'], completeness: 'complete' })
    expect(extractScriptPathFacts('import os\nopen(os.path.basename("/d/f.txt"))', 'python')).toMatchObject({ paths: ['f.txt'], completeness: 'complete' })
    expect(extractScriptPathFacts('import os\nroot = os.path.splitext("/d/f.txt")[0]\nopen(root)', 'python')).toMatchObject({ paths: ['/d/f'], completeness: 'complete' })
  })

  it('pathlib Path / PurePath 的 / 运算与构造器折叠', () => {
    expect(extractScriptPathFacts('from pathlib import Path\np = Path("/a") / "b"\nopen(p)', 'python')).toMatchObject({ paths: ['/a/b'], completeness: 'complete' })
    expect(extractScriptPathFacts('from pathlib import PurePath\nopen(PurePath("/a") / "b")', 'python')).toMatchObject({ paths: ['/a/b'], completeness: 'complete' })
  })

  it('import 别名形态的路径构造器同样折叠(osp.join / from-import join)', () => {
    expect(extractScriptPathFacts('import os.path as osp\nopen(osp.join("d", "f.txt"))', 'python')).toMatchObject({ paths: ['d/f.txt'], completeness: 'complete' })
    expect(extractScriptPathFacts('from os.path import join\nopen(join("d", "f.txt"))', 'python')).toMatchObject({ paths: ['d/f.txt'], completeness: 'complete' })
  })

  // ---- P0-2 局部变量常量传播 ----

  it('f3 join 赋值给变量后经 open(变量) 使用 → 传播生效', () => {
    expect(extractScriptPathFacts('import os\np = os.path.join("/d", "events.jsonl")\nopen(p, "r")', 'python')).toEqual({
      paths: ['/d/events.jsonl'], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: []
    })
  })

  it('f5 链式变量中转(嵌套 join + 字符串拼接)传播生效', () => {
    expect(extractScriptPathFacts('import os\nbase = os.path.join("/d", "sub")\ntarget = base + "/f.txt"\nopen(target)', 'python')).toMatchObject({ paths: ['/d/sub/f.txt'], completeness: 'complete' })
  })

  it('变量别名与跨块(-if 体内)传播生效', () => {
    expect(extractScriptPathFacts('p = "/a"\nq = p\nopen(q)', 'python')).toMatchObject({ paths: ['/a'], completeness: 'complete' })
    expect(extractScriptPathFacts('import os\nbase = os.path.join("/d", "data")\nif flag:\n    open(os.path.join(base, "x"))', 'python')).toMatchObject({ paths: ['/d/data/x'], completeness: 'complete' })
  })

  it('f19 典型会话数据分析脚本(join + json + Counter + with-open-as)判 complete', () => {
    const script = [
      'import os',
      'import json',
      'from collections import Counter',
      '',
      'LOG_DIR = os.path.join("logs", "app")',
      'TARGET = os.path.join(LOG_DIR, "events.jsonl")',
      '',
      'counter = Counter()',
      'with open(TARGET, "r") as f:',
      '    for line in f:',
      '        record = json.loads(line)',
      '        counter[record["type"]] += 1',
      'print(counter.most_common(5))'
    ].join('\n')
    expect(extractScriptPathFacts(script, 'python')).toEqual({
      paths: ['logs/app/events.jsonl'], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: []
    })
  })

  // ---- P0-3 纯计算白名单 ----

  it('f8/f9/f10 collections/json/re 纯计算调用不再触发 unknown', () => {
    expect(extractScriptPathFacts('from collections import Counter\nc = Counter("aabb")', 'python')).toMatchObject({ completeness: 'complete' })
    expect(extractScriptPathFacts('import json\njson.loads("{}")', 'python')).toMatchObject({ completeness: 'complete' })
    expect(extractScriptPathFacts('import re\nre.sub("a", "b", "aaa")', 'python')).toMatchObject({ completeness: 'complete' })
  })

  it('f7 os.walk 维持 unknown(§10-1 拍板:只读但枚举整棵目录树,保留 caution 级)', () => {
    expect(extractScriptPathFacts('import os\nfor root, dirs, files in os.walk("."):\n    pass', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('纯计算白名单负向:危险面(os.popen / os.remove 变量实参)仍 unknown', () => {
    expect(extractScriptPathFacts('import os\nos.popen("ls")', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
    expect(extractScriptPathFacts('import os\nos.remove(v)', 'python')).toMatchObject({ completeness: 'unknown' })
    expect(extractScriptPathFacts('import os\nos.system("rm -rf /")', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  // ---- P0-4 删除三处无条件 unknown ----

  it('f11/f12 函数定义与类定义(体内无 IO)不再触发 unknown;对已定义函数/类的调用同判', () => {
    expect(extractScriptPathFacts('def helper():\n    return 1\nhelper()', 'python')).toMatchObject({ completeness: 'complete' })
    expect(extractScriptPathFacts('class Config:\n    pass\nConfig()', 'python')).toMatchObject({ completeness: 'complete' })
    expect(extractScriptPathFacts('def load():\n    return 1\nv = load()', 'python')).toMatchObject({ completeness: 'complete' })
  })

  it('f14 自增赋值 x += 1 不再无条件 unknown', () => {
    expect(extractScriptPathFacts('x = 1\nx += 1', 'python')).toMatchObject({ completeness: 'complete' })
  })

  it('纯实例方法调用(Counter.update / most_common)不再触发 unknown', () => {
    expect(extractScriptPathFacts('from collections import Counter\nc = Counter()\nc.update([1, 2])\nprint(c.most_common())', 'python')).toMatchObject({ completeness: 'complete' })
  })

  it('P0-4 安全底线:函数体/类体内藏 IO 仍被检出', () => {
    expect(extractScriptPathFacts('def f():\n    open(target)\nf()', 'python')).toMatchObject({ completeness: 'unknown' })
    expect(extractScriptPathFacts('class C:\n    x = open(target)', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  // ---- P0-2 失效点(负向:任何重绑定/参数化写入即失效,§9 风险表) ----

  it('条件分支内的重绑定使常量传播失效(防假阴性)', () => {
    expect(extractScriptPathFacts('p = "/safe"\nif flag:\n    p = "/other"\nopen(p)', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('循环体内的重绑定按 loop-carried 失效(循环首轮即不可信)', () => {
    expect(extractScriptPathFacts('p = "/a"\nfor i in range(3):\n    open(p)\n    p = "/b"', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('for / comprehension 目标重绑定使同名常量失效', () => {
    expect(extractScriptPathFacts('p = "/a"\nfor p in range(3):\n    open(p)', 'python')).toMatchObject({ completeness: 'unknown' })
    expect(extractScriptPathFacts('p = "/a"\nrows = [open(p) for p in rows]\nopen(p)', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('aug_assign 重绑定失效(N3 负向示例:p += os.environ[X] 不得误判可静态确定)', () => {
    expect(extractScriptPathFacts('import os\np = "/safe"\np += os.environ["X"]\nopen(p)', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('下标增强赋值(容器变异)不重绑基名,纯度保留', () => {
    expect(extractScriptPathFacts('from collections import Counter\nc = Counter()\nc["x"] += 1\nprint(c.most_common())', 'python')).toMatchObject({ completeness: 'complete' })
  })

  it('del 与 with-as 重绑定使常量失效', () => {
    expect(extractScriptPathFacts('p = "/a"\ndel p\nopen(p)', 'python')).toMatchObject({ completeness: 'unknown' })
    expect(extractScriptPathFacts('p = "/a"\nwith open("/tmp/log") as p:\n    pass\nopen(p)', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('元组解包目标按名失效,不影响其他常量', () => {
    expect(extractScriptPathFacts('p = "/a"\na, b = "x", "y"\nopen(p)', 'python')).toMatchObject({ paths: ['/a'], completeness: 'complete' })
  })

  it('with-open-as 句柄的方法调用(f.read)不触发 unknown,路径在 open 处提取', () => {
    expect(extractScriptPathFacts('with open("/tmp/log") as f:\n    data = f.read()\nprint(len(data))', 'python')).toMatchObject({ paths: ['/tmp/log'], completeness: 'complete' })
  })

  it('导入别名赋值(alias = subprocess)不得经纯度传播洗白', () => {
    expect(extractScriptPathFacts('import subprocess as sp\nalias = sp\nalias.run("x")', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('常量不跨函数/类作用域传播(§P0-2 约束),函数包裹的 open(形参) 保持 unknown(§7.2 残留可解释)', () => {
    expect(extractScriptPathFacts('p = "/a"\ndef f():\n    open(p)', 'python')).toMatchObject({ completeness: 'unknown' })
    expect(extractScriptPathFacts('def load(path):\n    with open(path) as f:\n        return f.read()', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('§6 边界案例:未知来源函数结果流入 open 仍 unknown', () => {
    expect(extractScriptPathFacts('p = custom_api()\nopen(p)', 'python')).toMatchObject({ completeness: 'unknown' })
  })
})

// ============================================================================
// P1-1 unknown 双标志拆分(方案 §5 P1-1 / B2 前置条件):
// dynamic-execution = 动态执行面 / 动态路径(信息真断裂,维持强处置);
// unmodeled-call = 未建模调用(能力缺口,不作为风险信号)。
// :unknown 信号对两类继续产出(automation deny 不受影响),仅 script-dynamic-access 有区分度。
// ============================================================================
describe('extractScriptPathFacts:P1 unknown 分类', () => {
  beforeAll(async () => {
    await scriptParserService.ensureInitialized()
  })

  afterAll(() => resetScriptParserServiceForTests())

  it('动态执行面(eval / subprocess)与动态路径 open(变量) 归 dynamic-execution(§7.4 仍弹卡)', () => {
    expect(extractScriptPathFacts('eval(source)', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution' })
    expect(extractScriptPathFacts('import subprocess\nsubprocess.run(cmd)', 'python')).toMatchObject({ unknownReason: 'dynamic-execution' })
    expect(extractScriptPathFacts('open(target)', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution' })
    expect(extractScriptPathFacts('p = resolve()\nopen(p)', 'python')).toMatchObject({ unknownReason: 'dynamic-execution' })
  })

  it('未建模调用(customApi)归 unmodeled-call,不再带 dynamicAccess', () => {
    expect(extractScriptPathFacts('customApi()', 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: false, unknownReason: 'unmodeled-call' })
    expect(extractScriptPathFacts('some_module.do_thing("x")', 'python')).toMatchObject({ unknownReason: 'unmodeled-call' })
  })

  it('import 名重绑定视为事实链断裂归 dynamic-execution;global_nonlocal 同级(评审 N1:可改写外层绑定,禁记忆)', () => {
    expect(extractScriptPathFacts('import os\nos = fake\nopen("/a")', 'python')).toMatchObject({ completeness: 'unknown', unknownReason: 'dynamic-execution' })
    expect(extractScriptPathFacts('def f():\n    global counter\ncounter = 1', 'python')).toMatchObject({ unknownReason: 'dynamic-execution' })
  })

  it('fail-closed 闸门(语法错误/未接入语言)保守归 dynamic-execution(§10-5:与脚本内容无关的失败不松绑)', () => {
    expect(extractScriptPathFacts('open("/tmp/x"', 'python')).toMatchObject({ unknownReason: 'dynamic-execution' })
    expect(extractScriptPathFacts('ls -la', 'bash')).toMatchObject({ completeness: 'unknown', unknownReason: 'dynamic-execution' })
  })

  it('complete 结果 unknownReason 为 null', () => {
    expect(extractScriptPathFacts('print("hello")', 'python')).toEqual({ paths: [], completeness: 'complete', dynamicAccess: false, unknownReason: null, unknownEvidence: [] })
  })
})

// ============================================================================
// P2-1/P2-3:unknown 证据收集(调用名,方案 §5 P2-1「回显具体调用名」)与
// 声明式契约(§5 P2-3,# @path-scope workdir-readonly)。
// ============================================================================
describe('extractScriptPathFacts:P2 证据与声明', () => {
  beforeAll(async () => {
    await scriptParserService.ensureInitialized()
  })

  afterAll(() => resetScriptParserServiceForTests())

  it('unknown 时收集调用名证据(去重)', () => {
    const result = extractScriptPathFacts('custom_api()\nos.walk(".")\ncustom_api()', 'python')
    expect(result.unknownEvidence).toEqual([
      { call: 'custom_api', reason: 'unmodeled-call' },
      { call: 'os.walk', reason: 'unmodeled-call' }
    ])
  })

  it('动态执行面与动态路径证据归 dynamic-execution 类', () => {
    const result = extractScriptPathFacts('eval(x)\nopen(t)', 'python')
    expect(result.unknownEvidence).toEqual(expect.arrayContaining([
      { call: 'eval', reason: 'dynamic-execution' },
      { call: 'open', reason: 'dynamic-execution' }
    ]))
    expect(result.unknownEvidence).toHaveLength(2)
  })

  it('complete 时证据为空;fail-closed 出口证据为空数组', () => {
    expect(extractScriptPathFacts('print("x")', 'python').unknownEvidence).toEqual([])
    expect(extractScriptPathFacts('open("/tmp/x"', 'python').unknownEvidence).toEqual([])
  })

  it('证据条目封顶(防爆炸)', () => {
    const script = Array.from({ length: 15 }, (_, i) => `unknown_call_${i}()`).join('\n')
    expect(extractScriptPathFacts(script, 'python').unknownEvidence).toHaveLength(8)
  })

  it('识别首部 @path-scope workdir-readonly 声明(shebang/coding 注解行容忍)', () => {
    expect(extractScriptPathFacts('# @path-scope workdir-readonly\nprint("x")', 'python').declaration).toBe('workdir-readonly')
    expect(extractScriptPathFacts('#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n# @path-scope workdir-readonly\nprint(1)', 'python').declaration).toBe('workdir-readonly')
  })

  it('未知 scope 值或非首部声明不识别', () => {
    expect(extractScriptPathFacts('# @path-scope whatever\nprint("x")', 'python').declaration).toBeUndefined()
    expect(extractScriptPathFacts('import os\n# @path-scope workdir-readonly\nprint("x")', 'python').declaration).toBeUndefined()
    expect(extractScriptPathFacts('# @path-scope workdir-readonly\ncustom_api()', 'python').declaration).toBe('workdir-readonly')
  })
})

// ============================================================================
// 评审修复回归(2026-09-30 评审 B1/B2/B3 阻断项 + N1/N2 非阻断项):
// 三组对抗用例均为「确认门完全绕过」级——修复前全部判 complete 不弹卡。
// ============================================================================
describe('extractScriptPathFacts:评审修复回归(B1 defs 失效 / B2 元组目标 / B3 import 污染)', () => {
  beforeAll(async () => {
    await scriptParserService.ensureInitialized()
  })

  afterAll(() => resetScriptParserServiceForTests())

  // ---- B1:def 名重绑定后调用必须落回 unknown(defs 参与失效) ----

  it('B1a def 名被 = 重绑定为 os.system 后调用 → dynamic-execution(不弹卡的绕过)', () => {
    expect(extractScriptPathFacts([
      'import os',
      'def helper():',
      '    return 1',
      'helper = os.system',
      'helper("rm -rf /tmp/x")'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true })
  })

  it('B1b def 名被 for 目标重绑定后调用 → unknown', () => {
    expect(extractScriptPathFacts([
      'import os',
      'def helper():',
      '    return 1',
      'for helper in [os.system]:',
      '    helper("rm -rf /tmp/x")'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B1c def 名在分支内重绑定后调用 → unknown', () => {
    expect(extractScriptPathFacts([
      'import os',
      'def helper():',
      '    return 1',
      'if flag:',
      '    helper = os.system',
      'helper("rm -rf /tmp/x")'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B1d/N3 with-as 重绑定 def 名后调用 → unknown', () => {
    expect(extractScriptPathFacts([
      'def helper():',
      '    return 1',
      'with ctx() as helper:',
      '    helper("x")'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B1 回归对照:未重绑定的 def 名调用仍 complete(不过度收紧)', () => {
    expect(extractScriptPathFacts('def helper():\n    return 1\nhelper()', 'python')).toMatchObject({ completeness: 'complete' })
  })

  // ---- B2:for / comprehension 元组目标不失效导致动态路径误判 complete ----

  it('B2a for 元组目标重绑定同名常量后 open(p) → unknown(不再只登记 /safe.txt)', () => {
    expect(extractScriptPathFacts([
      'p = "/safe.txt"',
      'for p, q in items:',
      '    open(p)'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B2b 元组 comprehension 目标重绑定同名常量 → unknown', () => {
    expect(extractScriptPathFacts([
      'p = "/safe.txt"',
      'rows = [open(p) for p, q in rows]'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  // ---- B3:import os.path 污染链解析,os.* 危险调用逃逸纯白名单 ----

  it('B3a import os.path 后 os.system → dynamic-execution(不再命中 os.path.* 纯白名单)', () => {
    expect(extractScriptPathFacts('import os.path\nos.system("rm -rf /tmp/x")', 'python')).toMatchObject({
      completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution'
    })
  })

  it('B3b import os.path 后 os.popen / os.remove(变量) → unknown', () => {
    expect(extractScriptPathFacts('import os.path\nos.popen("ls")', 'python')).toMatchObject({ unknownReason: 'dynamic-execution' })
    expect(extractScriptPathFacts('import os.path\nos.remove(v)', 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B3 回归对照:import os.path 后 os.path.join 折叠与 os.system 检测两不误', () => {
    expect(extractScriptPathFacts('import os.path\nopen(os.path.join("d", "f.txt"))', 'python')).toMatchObject({
      paths: ['d/f.txt'], completeness: 'complete'
    })
  })

  // ---- N1:global_nonlocal 改写场景恢复基线强度(dynamic-execution) ----

  it('N1 global 声明(含模块级常量被函数内改写场景)归 dynamic-execution,禁记忆', () => {
    expect(extractScriptPathFacts([
      'p = "ok.txt"',
      'def f():',
      '    global p',
      '    p = "/etc/passwd"'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution' })
  })

  // ---- N2:上限保护 ----

  it('N2a 常量环境条目封顶(超出后不再绑定,折叠自然失效落 unknown)', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `v${i} = "/p${i}"`)
    lines.push('open(v0)', 'open(v399)')
    const result = extractScriptPathFacts(lines.join('\n'), 'python')
    expect(result.completeness).toBe('unknown')
  })

  it('N2b 深嵌套表达式折叠有深度上限(不栈溢出,结果保守)', () => {
    const deep = 'x = ' + '('.repeat(200) + '"a"' + ' + "/b")'.repeat(200)
    expect(() => extractScriptPathFacts(deep, 'python')).not.toThrow()
  })
})

// ============================================================================
// v2 评审修复回归(B2-R 带括号/嵌套元组目标 / B1-R 函数参数遮蔽 def 名):
// 同 B1/B2 根因的变体形态,修复前均判 complete 完全绕过确认门。
// ============================================================================
describe('extractScriptPathFacts:v2 评审修复回归(变体形态)', () => {
  beforeAll(async () => {
    await scriptParserService.ensureInitialized()
  })

  afterAll(() => resetScriptParserServiceForTests())

  // ---- B2-R:带括号/嵌套元组目标 ----

  it('B2-Ra for 带括号扁平元组目标 (p, q) 重绑定同名常量 → unknown', () => {
    expect(extractScriptPathFacts([
      'p = "/safe.txt"',
      'for (p, q) in items:',
      '    open(p)'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B2-Rb 嵌套元组目标 x, (p, r) 重绑定同名常量 → unknown', () => {
    expect(extractScriptPathFacts([
      'p = "/safe.txt"',
      'for x, (p, r) in items:',
      '    open(p)'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B2-Rc 带括号元组的 comprehension 目标 → unknown', () => {
    expect(extractScriptPathFacts([
      'p = "/safe.txt"',
      'rows = [open(p) for (p, q) in rows]'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B2-R 对照:元组目标与常量不同名时不误伤(正常传播保持)', () => {
    expect(extractScriptPathFacts([
      'p = "/safe.txt"',
      'for x, y in items:',
      '    open(p)'
    ].join('\n'), 'python')).toMatchObject({ paths: ['/safe.txt'], completeness: 'complete' })
  })

  // ---- B1-R:函数参数遮蔽 def 名 ----

  it('B1-Ra 参数遮蔽 def 名后体内调用(评审 PoC)→ unknown', () => {
    expect(extractScriptPathFacts([
      'import os',
      'def helper():',
      '    pass',
      'def run(helper):',
      '    helper("rm -rf /tmp/x")',
      'run(os.system)'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B1-Rb 带默认值参数形态同样剔除 def 名 → unknown', () => {
    expect(extractScriptPathFacts([
      'import os',
      'def helper():',
      '    pass',
      'def run(helper=None):',
      '    helper("rm -rf /tmp/x")',
      'run(os.system)'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B1-Rc *args 形态剔除 def 名 → unknown(保守:绑定值不可调用也不放行)', () => {
    expect(extractScriptPathFacts([
      'def helper():',
      '    pass',
      'def run(*helper):',
      '    helper("rm -rf /tmp/x")'
    ].join('\n'), 'python')).toMatchObject({ completeness: 'unknown' })
  })

  it('B1-R 对照:普通参数名(不与 def 同名)不误伤', () => {
    expect(extractScriptPathFacts('def run(path):\n    open("/tmp/known.txt")\nrun("x")', 'python')).toMatchObject({
      paths: ['/tmp/known.txt'], completeness: 'complete'
    })
  })
})
