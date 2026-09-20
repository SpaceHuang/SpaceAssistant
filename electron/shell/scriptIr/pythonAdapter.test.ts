// P1-T2：Python IR 适配器测试（全量覆盖 + 结构快照 + 反向用例）。
// TDD：本文件先于 pythonAdapter.ts 实现编写（红 → 绿）。
import fs from 'node:fs'
import path from 'node:path'
import {
  scriptParserService,
  resetScriptParserServiceForTests
} from '../scriptParserService'
import {
  adaptPythonModule,
  foldStringIr,
  resolveIrChain,
  type IrScope
} from './pythonAdapter'
import { IrCoverageError } from './types'
import {
  IR_MODELED,
  IGNORABLE_LEAF_NODES,
  PASSTHROUGH_NODES,
  PASSTHROUGH_JUSTIFICATIONS,
  EXPLICITLY_UNMODELED,
  PASSTHROUGH_NAME_BLACKLIST,
  SEMANTIC_CONTAINER_BAN,
  isClassified
} from './pythonNodeClassification'
import type { IrExpr, IrModule } from './types'

function adapt(source: string): IrModule {
  const outcome = scriptParserService.parse('python', source)
  if (!outcome.ok) throw new Error(`setup: parse failed (${outcome.reason}) for ${JSON.stringify(source)}`)
  const ir = adaptPythonModule(outcome.tree)
  outcome.tree.delete()
  return ir
}

function exprOf(source: string): IrExpr {
  const ir = adapt(source)
  const stmt = ir.body[ir.body.length - 1]
  if (stmt?.kind !== 'expr') throw new Error(`last stmt is ${stmt?.kind}, expected expr`)
  return stmt.value
}

beforeAll(async () => {
  resetScriptParserServiceForTests()
  await scriptParserService.ensureInitialized()
})

describe('pythonAdapter：已建模范围正例（清单为下限非上限）', () => {
  it('import / from-import / 别名', () => {
    expect(adapt('import os\n')).toEqual({ body: [{ kind: 'import', names: [{ module: 'os' }] }] })
    expect(adapt('import os as o\n')).toEqual({ body: [{ kind: 'import', names: [{ module: 'os', alias: 'o' }] }] })
    expect(adapt('import urllib.request\n')).toEqual({
      body: [{ kind: 'import', names: [{ module: 'urllib.request' }] }]
    })
    expect(adapt('from os import system\n')).toEqual({
      body: [{ kind: 'from_import', module: 'os', names: [{ name: 'system' }] }]
    })
    expect(adapt('from os import system as s\n')).toEqual({
      body: [{ kind: 'from_import', module: 'os', names: [{ name: 'system', alias: 's' }] }]
    })
    expect(adapt('from os.path import *\n')).toEqual({
      body: [{ kind: 'from_import', module: 'os.path', names: [{ name: '*' }] }]
    })
  })

  it('assign / aug_assign / 重绑赋值', () => {
    expect(adapt('x = 1\n')).toEqual({ body: [{ kind: 'assign', targets: ['x'], value: { kind: 'number', value: '1' } }] })
    const aug = adapt('i += 1\n')
    expect(aug.body[0]).toEqual({ kind: 'aug_assign', target: 'i', value: { kind: 'number', value: '1' } })
  })

  it('调用与属性链（含 kwargs）', () => {
    const e = exprOf('os.path.join("a", "b")\n')
    expect(e).toEqual({
      kind: 'call',
      callee: { kind: 'attr', base: { kind: 'attr', base: { kind: 'name', id: 'os' }, attr: 'path' }, attr: 'join' },
      args: [
        { kind: 'string', value: 'a' },
        { kind: 'string', value: 'b' }
      ],
      kwargs: []
    })
    const kw = exprOf('connect(host="h", port=8080)\n')
    expect(kw.kind === 'call' && kw.kwargs).toEqual([
      { name: 'host', value: { kind: 'string', value: 'h' } },
      { name: 'port', value: { kind: 'number', value: '8080' } }
    ])
  })

  it('下标与切片', () => {
    expect(exprOf('items[0]\n')).toEqual({
      kind: 'subscript',
      value: { kind: 'name', id: 'items' },
      index: { kind: 'number', value: '0' }
    })
    expect(exprOf('items[1:2]\n')).toEqual({
      kind: 'subscript',
      value: { kind: 'name', id: 'items' },
      index: { kind: 'slice', lower: { kind: 'number', value: '1' }, upper: { kind: 'number', value: '2' }, step: null }
    })
  })

  it('三元表达式', () => {
    expect(exprOf('x if c else y\n')).toEqual({
      kind: 'conditional',
      test: { kind: 'name', id: 'c' },
      body: { kind: 'name', id: 'x' },
      orelse: { kind: 'name', id: 'y' }
    })
  })

  it('运算符族（binary/comparison/boolean/unary/not）与基础字面量（发现 F）', () => {
    expect(exprOf('1 + 2\n')).toEqual({
      kind: 'binop',
      op: '+',
      left: { kind: 'number', value: '1' },
      right: { kind: 'number', value: '2' }
    })
    expect(exprOf('1.5 * 2.0\n').kind).toBe('binop')
    const cmp = exprOf('a < b\n')
    expect(cmp.kind === 'compare' && cmp.op).toBe('<')
    expect(exprOf('a and b\n').kind).toBe('boolop')
    expect(exprOf('-x\n')).toEqual({ kind: 'unaryop', op: '-', operand: { kind: 'name', id: 'x' } })
    expect(exprOf('not x\n')).toEqual({ kind: 'unaryop', op: 'not', operand: { kind: 'name', id: 'x' } })
    expect(exprOf('True\n')).toEqual({ kind: 'bool', value: true })
    expect(exprOf('None\n')).toEqual({ kind: 'none' })
  })

  it('字符串常量：普通 / 隐式拼接 / f-string 静态拼接与插值', () => {
    expect(exprOf('"abc"\n')).toEqual({ kind: 'string', value: 'abc' })
    // 隐式拼接 "a" "b" → 合并为单 string（剥离引号后拼接，语义等价 Python 常量折叠）
    expect(exprOf('"a" "b"\n')).toEqual({ kind: 'string', value: 'ab' })
    // f-string：静态部分拼接 + 插值表达式单独承载（防插值内调用逃逸）
    const fs = exprOf('f"hello {name}!"\n')
    expect(fs.kind).toBe('f_string')
    if (fs.kind === 'f_string') {
      expect(fs.staticParts.join('')).toBe('hello !')
      expect(fs.interpolations).toEqual([{ kind: 'name', id: 'name' }])
    }
  })

  it('if / for / while / with / try 语句递归', () => {
    const ifIr = adapt('if x:\n    y = 1\nelse:\n    y = 2\n')
    expect(ifIr.body[0]!.kind).toBe('if')
    const forIr = adapt('for i in items:\n    print(i)\n')
    expect(forIr.body[0]!.kind).toBe('for')
    const whileIr = adapt('while x:\n    x = False\n')
    expect(whileIr.body[0]!.kind).toBe('while')
    const withIr = adapt('with open("f") as fh:\n    data = fh.read()\n')
    expect(withIr.body[0]!.kind).toBe('with')
    if (withIr.body[0]!.kind === 'with') {
      expect(withIr.body[0]!.items[0]!.optionalVars).toEqual(['fh'])
    }
    const tryIr = adapt('try:\n    a()\nexcept ValueError as e:\n    b()\nfinally:\n    c()\n')
    expect(tryIr.body[0]!.kind).toBe('try')
  })

  it('def / class（含装饰器）/ async / await', () => {
    const defIr = adapt('@staticmethod\ndef f(x, y=1):\n    return x\n')
    expect(defIr.body[0]!.kind).toBe('function_def')
    if (defIr.body[0]!.kind === 'function_def') {
      expect(defIr.body[0]!.name).toBe('f')
      expect(defIr.body[0]!.params).toEqual(['x', 'y'])
      expect(defIr.body[0]!.decorators.length).toBe(1)
    }
    const classIr = adapt('class A(B):\n    pass\n')
    expect(classIr.body[0]!.kind).toBe('class_def')
    const asyncIr = adapt('async def job():\n    await work()\n')
    expect(asyncIr.body[0]!.kind).toBe('function_def')
    if (asyncIr.body[0]!.kind === 'function_def') expect(asyncIr.body[0]!.isAsync).toBe(true)
  })

  it('lambda / 列表元组字典集合字面量 / 推导式', () => {
    expect(adapt('f = lambda x: x\n').body[0]!.kind).toBe('assign')
    expect(exprOf('[1, 2]\n')).toEqual({ kind: 'list', elts: [{ kind: 'number', value: '1' }, { kind: 'number', value: '2' }] })
    expect(exprOf('(1, 2)\n').kind).toBe('tuple')
    expect(exprOf('{"k": 1}\n').kind).toBe('dict')
    expect(exprOf('{1, 2}\n').kind).toBe('set')
    expect(exprOf('[x for x in items]\n').kind).toBe('comprehension')
    expect(exprOf('{k: v for k, v in pairs}\n').kind).toBe('comprehension')
  })
})

describe('pythonAdapter：壳节点穿透（③）与归属保持', () => {
  it.each([
    ['f(1, 2)\n', 'call 参数壳'],
    ['def f(x):\n    return x\n', '函数定义 parameters/block 壳'],
    ['if x:\n    y = 1\n', 'if block 壳'],
    ['for i in y:\n    z = 1\n', 'for block 壳']
  ])('壳构造正常产 IR 而非抛 IrCoverageError：%s', (code) => {
    expect(() => adapt(code)).not.toThrow(IrCoverageError)
    expect(adapt(code).body.length).toBeGreaterThan(0)
  })

  it('穿透不改归属：f(a, b=1) 与 open(p, mode="w") 的 kwargs 分组正确（发现 A）', () => {
    const call = exprOf('f(a, b=1)\n')
    expect(call.kind).toBe('call')
    if (call.kind === 'call') {
      expect(call.args).toEqual([{ kind: 'name', id: 'a' }])
      expect(call.kwargs).toEqual([{ name: 'b', value: { kind: 'number', value: '1' } }])
    }
    const openCall = exprOf('open(p, mode="w")\n')
    expect(openCall.kind).toBe('call')
    if (openCall.kind === 'call') {
      expect(openCall.args).toEqual([{ kind: 'name', id: 'p' }])
      expect(openCall.kwargs).toEqual([{ name: 'mode', value: { kind: 'string', value: 'w' } }])
    }
  })
})

describe('pythonAdapter：原解析失败构造产非空 IR（评估文档 §1.1 构造族）', () => {
  it.each([
    ['dict 字面量', 'd = {"k": 1}\n'],
    ['f-string', 'print(f"x {y}")\n'],
    ['with open', 'with open("f") as fh:\n    fh.read()\n'],
    ['try/except', 'try:\n    a()\nexcept:\n    pass\n'],
    ['def', 'def f():\n    pass\n'],
    ['装饰器', '@d\ndef f():\n    pass\n'],
    ['async', 'async def f():\n    pass\n'],
    ['lambda', 'g = lambda: 1\n'],
    ['下标', 'a = b[0]\n']
  ])('%s → 非空 IR', (_name, code) => {
    const ir = adapt(code)
    expect(ir.body.length).toBeGreaterThan(0)
  })
})

describe('pythonAdapter：穷尽性 + 白名单叶子性 + ③ 双护栏（机械护栏，防手滑）', () => {
  const nodeTypesPath = path.resolve(__dirname, '../../../resources/tree-sitter/python-node-types.json')
  const nodeTypes = JSON.parse(fs.readFileSync(nodeTypesPath, 'utf8')) as Array<Record<string, unknown>>

  it('分类表覆盖 node-types.json 全部具体 named 种类（①∪②∪③∪④）', () => {
    const supertypes = new Set(nodeTypes.filter((t) => t.named && t.subtypes).map((t) => String(t.type)))
    const concrete = nodeTypes.filter((t) => t.named && !supertypes.has(String(t.type))).map((t) => String(t.type))
    const missing = concrete.filter((t) => !isClassified(t) && !(t in EXPLICITLY_UNMODELED))
    expect(missing).toEqual([])
    const tabled = new Set([...IR_MODELED, ...IGNORABLE_LEAF_NODES, ...PASSTHROUGH_NODES, ...Object.keys(EXPLICITLY_UNMODELED)])
    // as_pattern_target 是 grammar 运行时种类（node-types.json 顶层条目未列出，实测语法树出现）
    const RUNTIME_EXTRA = ['as_pattern_target']
    const extra = [...tabled].filter((t) => !concrete.includes(t) && !RUNTIME_EXTRA.includes(t))
    expect(extra).toEqual([])
  })

  it('② 白名单叶子性：每个可忽略种类在 node-types.json 中无 fields 且无 named children（M2‴）', () => {
    const byType = new Map(nodeTypes.map((t) => [String(t.type), t]))
    for (const t of IGNORABLE_LEAF_NODES) {
      const info = byType.get(t)
      expect(info, `② 种类 ${t} 不在 node-types.json`).toBeTruthy()
      expect(Object.keys(info!.fields ?? {})).toEqual([])
      const namedChildren = ((info!.children?.types as Array<Record<string, unknown>> | undefined) ?? []).filter((c) => c.named)
      expect(namedChildren, `② 种类 ${t} 有 named children，不是叶子`).toEqual([])
    }
  })

  it('③ 双护栏：名称黑名单 + 语义容器禁入，且 justification 非空（发现 A）', () => {
    for (const t of PASSTHROUGH_NODES) {
      expect(PASSTHROUGH_NAME_BLACKLIST.test(t), `③ 名称黑名单命中：${t}`).toBe(false)
      expect(SEMANTIC_CONTAINER_BAN.has(t), `③ 语义容器禁入清单命中：${t}`).toBe(false)
      expect(PASSTHROUGH_JUSTIFICATIONS[t], `③ ${t} 缺 justification`).toBeTruthy()
    }
    // 护栏性质声明：机械护栏只是防手滑，真正兜底是 P1-T5 Golden 比对与本文件 IR 结构快照。
  })
})

describe('pythonAdapter：禁净退化（P1-T0 现状可解析集零 IrCoverageError）', () => {
  const goldenDir = path.resolve(__dirname, '../testdata/golden/python')
  const manifest = JSON.parse(fs.readFileSync(path.join(goldenDir, 'manifest.json'), 'utf8')) as {
    samples: Array<{ id: string; group: string }>
  }

  it('A 组每条样本适配不抛 IrCoverageError', () => {
    let count = 0
    for (const { id, group } of manifest.samples) {
      if (group !== 'legacy-parseable') continue
      const code = fs.readFileSync(path.join(goldenDir, `${id}.py`), 'utf8')
      let ir: IrModule | null = null
      try {
        ir = adapt(code)
      } catch (err) {
        if (err instanceof IrCoverageError) {
          throw new Error(`禁净退化破坏：A 组样本 ${id} 落 IrCoverageError（${err.nodeType}）`)
        }
        throw err
      }
      expect(ir.body).toBeDefined()
      count += 1
    }
    expect(count).toBeGreaterThanOrEqual(40)
  })
})

describe('pythonAdapter：未知构造反向用例（④ 抛 IrCoverageError）', () => {
  it.each([
    ['match 语句', 'def f(x):\n    match x:\n        case 1:\n            pass\n'],
    ['type 别名语句', 'type Alias = int\n'],
    ['泛型类型注解（扩展形态）', 'def f(x: list[int] = []) -> None:\n    pass\n']
  ])('%s → parsePythonModule 抛 IrCoverageError', (_name, code) => {
    expect(() => adapt(code)).toThrow(IrCoverageError)
  })
})

describe('pythonAdapter：IR 结构快照（独立于判定结果的中间层断言，≥30 条）', () => {
  // 每条：源码 + 期望归一化 IR body（完整 JSON 形状断言，防「判定级 bug 互相抵消」盲区）
  const CASES: Array<[string, unknown]> = [
    ['x = 1', [{ kind: 'assign', targets: ['x'], value: { kind: 'number', value: '1' } }]],
    ['print("hi")', [{ kind: 'expr', value: { kind: 'call', callee: { kind: 'name', id: 'print' }, args: [{ kind: 'string', value: 'hi' }], kwargs: [] } }]],
    ['import os', [{ kind: 'import', names: [{ module: 'os' }] }]],
    ['import numpy as np', [{ kind: 'import', names: [{ module: 'numpy', alias: 'np' }] }]],
    ['from sys import argv', [{ kind: 'from_import', module: 'sys', names: [{ name: 'argv' }] }]],
    ['from json import dumps as d', [{ kind: 'from_import', module: 'json', names: [{ name: 'dumps', alias: 'd' }] }]],
    ['y = "a" + "b"', [{ kind: 'assign', targets: ['y'], value: { kind: 'binop', op: '+', left: { kind: 'string', value: 'a' }, right: { kind: 'string', value: 'b' } } }]],
    ['flag = True', [{ kind: 'assign', targets: ['flag'], value: { kind: 'bool', value: true } }]],
    ['z = None', [{ kind: 'assign', targets: ['z'], value: { kind: 'none' } }]],
    ['pairs = (1, 2)', [{ kind: 'assign', targets: ['pairs'], value: { kind: 'tuple', elts: [{ kind: 'number', value: '1' }, { kind: 'number', value: '2' }] } }]],
    ['lst = []', [{ kind: 'assign', targets: ['lst'], value: { kind: 'list', elts: [] } }]],
    ['o = obj.attr', [{ kind: 'assign', targets: ['o'], value: { kind: 'attr', base: { kind: 'name', id: 'obj' }, attr: 'attr' } }]],
    ['v = a[0]', [{ kind: 'assign', targets: ['v'], value: { kind: 'subscript', value: { kind: 'name', id: 'a' }, index: { kind: 'number', value: '0' } } }]],
    ['t = a if c else b', [{ kind: 'assign', targets: ['t'], value: { kind: 'conditional', test: { kind: 'name', id: 'c' }, body: { kind: 'name', id: 'a' }, orelse: { kind: 'name', id: 'b' } } }]],
    ['n = -x', [{ kind: 'assign', targets: ['n'], value: { kind: 'unaryop', op: '-', operand: { kind: 'name', id: 'x' } } }]],
    ['c = a < b', [{ kind: 'assign', targets: ['c'], value: { kind: 'compare', op: '<', left: { kind: 'name', id: 'a' }, right: { kind: 'name', id: 'b' } } }]],
    ['b2 = a and b', [{ kind: 'assign', targets: ['b2'], value: { kind: 'boolop', op: 'and', values: [{ kind: 'name', id: 'a' }, { kind: 'name', id: 'b' }] } }]],
    ['f2 = lambda x: x', [{ kind: 'assign', targets: ['f2'], value: { kind: 'lambda', params: ['x'], defaults: [], body: { kind: 'name', id: 'x' } } }]],
    ['dd = {"k": 1}', [{ kind: 'assign', targets: ['dd'], value: { kind: 'dict', keys: [{ kind: 'string', value: 'k' }], values: [{ kind: 'number', value: '1' }] } }]],
    ['s2 = {1, 2}', [{ kind: 'assign', targets: ['s2'], value: { kind: 'set', elts: [{ kind: 'number', value: '1' }, { kind: 'number', value: '2' }] } }]],
    ['i += 1', [{ kind: 'aug_assign', target: 'i', value: { kind: 'number', value: '1' } }]],
    ['del x', [{ kind: 'delete', targets: [{ kind: 'name', id: 'x' }] }]],
    ['raise ValueError("e")', [{ kind: 'raise', value: { kind: 'call', callee: { kind: 'name', id: 'ValueError' }, args: [{ kind: 'string', value: 'e' }], kwargs: [] } }]],
    ['assert ok', [{ kind: 'assert', test: { kind: 'name', id: 'ok' } }]],
    ['pass', [{ kind: 'pass' }]],
    ['return_now = None\nif x:\n    pass', [{ kind: 'assign', targets: ['return_now'], value: { kind: 'none' } }, { kind: 'if', test: { kind: 'name', id: 'x' }, body: [{ kind: 'pass' }], orelse: [] }]],
    ['while True:\n    break', [{ kind: 'while', test: { kind: 'bool', value: true }, body: [{ kind: 'break' }], orelse: [] }]],
    ['for i in [1]:\n    continue', [{ kind: 'for', target: 'i', iter: { kind: 'list', elts: [{ kind: 'number', value: '1' }] }, body: [{ kind: 'continue' }], orelse: [] }]],
    ['with open("f"):\n    pass', [{ kind: 'with', items: [{ contextExpr: { kind: 'call', callee: { kind: 'name', id: 'open' }, args: [{ kind: 'string', value: 'f' }], kwargs: [] }, optionalVars: [] }], body: [{ kind: 'pass' }] }]],
    ['try:\n    pass\nfinally:\n    pass', [{ kind: 'try', body: [{ kind: 'pass' }], handlers: [], orelse: [], finalbody: [{ kind: 'pass' }] }]],
    ['g = (x for x in y)', [{ kind: 'assign', targets: ['g'], value: { kind: 'comprehension', elt: { kind: 'name', id: 'x' }, generators: [{ target: 'x', iter: { kind: 'name', id: 'y' } }], compKind: 'generator' } }]],
    ['await_task = await f()', [{ kind: 'assign', targets: ['await_task'], value: { kind: 'await', value: { kind: 'call', callee: { kind: 'name', id: 'f' }, args: [], kwargs: [] } } }]]
  ]

  it.each(CASES)('IR 快照：%s', (code, expectedBody) => {
    expect(adapt(`${code}\n`).body).toEqual(expectedBody)
  })

  it('resolveIrChain：模块别名 / from-import 绑定 / 重绑传递', () => {
    // import os as o → o.system 解析为 module=os, attrs=[system]
    const scope1: IrScope = { modules: new Map([['o', 'os']]), attrs: new Map() }
    const chain1 = resolveIrChain(exprOf('o.system\n'), scope1)
    expect(chain1).toEqual({ root: 'o', module: 'os', attrs: ['system'], fullName: 'os.system' })
    // from os import system as s → s 解析为 os.system 绑定
    const scope2: IrScope = { modules: new Map(), attrs: new Map([['s', { module: 'os', attr: 'system' }]]) }
    const chain2 = resolveIrChain(exprOf('s\n'), scope2)
    expect(chain2).toEqual({ root: 's', module: 'os', attrs: ['system'], fullName: 'os.system' })
    // 链穿透：a.b.c（a 为未知根）→ module=a
    const chain3 = resolveIrChain(exprOf('a.b.c\n'), { modules: new Map(), attrs: new Map() })
    expect(chain3).toEqual({ root: 'a', module: 'a', attrs: ['b', 'c'], fullName: 'a.b.c' })
  })

  it('foldStringIr：拼接折叠 / 单元素 tuple / f-string 全静态折叠 / 插值不可折叠', () => {
    expect(foldStringIr({ kind: 'string', value: 'a' })).toBe('a')
    expect(foldStringIr({ kind: 'binop', op: '+', left: { kind: 'string', value: 'a' }, right: { kind: 'string', value: 'b' } })).toBe('ab')
    expect(foldStringIr({ kind: 'tuple', elts: [{ kind: 'string', value: 'a' }] })).toBe('a')
    expect(foldStringIr({ kind: 'f_string', staticParts: ['a', 'b'], interpolations: [] })).toBe('ab')
    expect(foldStringIr({ kind: 'f_string', staticParts: ['a'], interpolations: [{ kind: 'name', id: 'x' }] })).toBeNull()
    expect(foldStringIr({ kind: 'name', id: 'x' })).toBeNull()
  })
})
