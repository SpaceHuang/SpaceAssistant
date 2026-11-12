import { describe, expect, it } from 'vitest'
import { analyzeScriptContent, DANGEROUS_MODULES, parsePythonModule } from './scriptContentSecurity'
import { scriptParserService } from './scriptParserService'

type Expectation = { patternIds?: string[] }

function expectAnalysis(code: string, _remoteContext: boolean | undefined, exp: Expectation): void {
  const result = analyzeScriptContent(code)
  if (exp.patternIds) {
    const actualPatternIds = result.findings.map((finding) => finding.pattern)
    for (const patternId of exp.patternIds) expect(actualPatternIds).toContain(patternId)
  }
}

describe('scriptContentSecurity — List A (baseline)', () => {
  it('produces one located finding per A1 call with stable pattern IDs', () => {
    const r = analyzeScriptContent("import os\nos.system('first')\nos.system('second')")
    expect(r.findings.map((finding) => finding.pattern)).toEqual(['A1', 'A1'])
    expect(r.findings).toMatchObject([
      { pattern: 'A1', class: 'process-creation', range: { startLine: 2, startCol: 1, endLine: 2 }, snippet: "os.system('first')" },
      { pattern: 'A1', class: 'process-creation', range: { startLine: 3, startCol: 1, endLine: 3 }, snippet: "os.system('second')" }
    ])
    expect(r.totalCount).toBe(2)
  })

  it.each([
    ['A2 destructive filesystem operation', "import os\nos.remove('old.txt')", 'A2', 'destructive-fs', 'fs-destructive'],
    ['A7 file write', "open('/tmp/out.txt', 'w')", 'A7', 'file-write', 'write-path'],
    ['A8 relative file write', "open('out.txt', 'w')", 'A8', 'file-write', 'write-path']
  ] as const)('%s yields a positioned finding with structural evidence', (_name, code, pattern, findingClass, evidenceKind) => {
    const result = analyzeScriptContent(code)
    expect(result.findings).toEqual([
      expect.objectContaining({ pattern, class: findingClass, range: expect.any(Object), snippet: expect.any(String), evidence: expect.objectContaining({ kind: evidenceKind }) })
    ])
    expect(result.totalCount).toBe(result.findings?.length)
  })

  it.each([
    ['dynamic-execution with bound input', "source = input()\nexec(source)", 'dynamic-execution', 'dynamic-exec'],
    ['network call without static host', "import requests\nrequests.get(url)", 'network-api', 'network'],
    ['cwd change with dynamic path', "import os\nos.chdir(target)", 'cwd-change', 'cwd-change'],
    ['decode binding close to exec', "import base64\npayload = base64.b64decode(data)\nexec(payload)", 'decode-then-exec', 'decode-exec'],
    ['dynamic subscript dispatch', "handlers[name]()", 'dynamic-dispatch', 'dynamic-dispatch']
  ] as const)('%s remains located when key evidence is dynamic', (_name, code, findingClass, evidenceKind) => {
    const result = analyzeScriptContent(code)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: findingClass, range: expect.any(Object), snippet: expect.any(String), evidence: expect.objectContaining({ kind: evidenceKind }) })
    ]))
  })

  it('captures the static network host and exact dynamic-execution entry', () => {
    const network = analyzeScriptContent("import requests\nrequests.get('https://api.example.test/v1')").findings?.find((finding) => finding.class === 'network-api')
    const execution = analyzeScriptContent("exec('pass')").findings?.find((finding) => finding.class === 'dynamic-execution')
    expect(network?.evidence).toMatchObject({ kind: 'network', module: 'requests', attr: 'get', host: 'api.example.test' })
    expect(execution?.evidence).toMatchObject({ kind: 'dynamic-exec', entry: 'exec' })
  })

  it.each([
    ['dynamic-execution', "eval('1 + 1')", 'A3', 'dynamic-execution', 'dynamic-exec'],
    ['dynamic-import', "__import__('os')", 'A4', 'dynamic-import', 'dynamic-import'],
    ['native-code-load', "import ctypes\nctypes.CDLL('libx.so')", 'A5', 'native-code-load', 'native-code'],
    ['network-api', "import requests\nrequests.get('https://example.test/path')", 'A6', 'network-api', 'network'],
    ['cwd-change', "import os\nos.chdir('../work')", 'A9', 'cwd-change', 'cwd-change'],
    ['reflection', "getattr(__import__('os'), 'system')", 'B2', 'reflection', 'reflection'],
    ['alias-resolution', "import os as operating\noperating.system('id')", 'B5', 'alias-resolution', 'alias'],
    ['decode-then-exec', "import base64\nexec(base64.b64decode('cGFzcw=='))", 'B11', 'decode-then-exec', 'decode-exec'],
    ['dynamic-dispatch', "obj[key]()", 'B9', 'dynamic-dispatch', 'dynamic-dispatch']
  ] as const)('%s emits a located finding with category evidence', (_name, code, pattern, findingClass, evidenceKind) => {
    const result = analyzeScriptContent(code)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern, class: findingClass, range: expect.any(Object), snippet: expect.any(String), evidence: expect.objectContaining({ kind: evidenceKind }) })
    ]))
  })

  it('keeps the full unusually long finding snippet and its source range', () => {
    const code = `open('/tmp/${'x'.repeat(2500)}', 'w')`
    const finding = analyzeScriptContent(code).findings?.[0]
    expect(finding?.snippet).toBe(code)
    expect(finding?.range.endCol).toBe(code.length + 1)
  })

  it('does not infer a write target from an arbitrary call argument', () => {
    const finding = analyzeScriptContent("open(os.path.join('base', '/tmp/out'), 'w')").findings?.[0]
    expect(finding?.evidence).toMatchObject({ kind: 'write-path', rawPath: null, pathClass: 'unresolved' })
  })

  it.each([
    ['Path', 'from pathlib import Path\nPath("/tmp/out").write_text("x")', '/tmp/out', 'absolute'],
    ['Path alias', 'from pathlib import Path as P\nP("/tmp/out").write_bytes(b"x")', '/tmp/out', 'absolute'],
    ['module Path', 'import pathlib as pl\npl.Path("../out").write_text("x")', '../out', 'dotdot'],
    ['relative Path', 'from pathlib import Path\nPath("out").write_text("x")', 'out', 'relative'],
    ['multi-argument Path', 'from pathlib import Path\nPath("base", "/tmp/out").write_text("x")', null, 'unresolved']
  ])('retains verified %s constructor path in write evidence', (_name, code, rawPath, pathClass) => {
    expect(analyzeScriptContent(code).findings?.[0]?.evidence).toMatchObject({ kind: 'write-path', rawPath, pathClass })
  })

  it('does not treat a shadowed Path name or arbitrary call as a pathlib constructor', () => {
    for (const code of [
      'Path = custom\nPath("/tmp/out").write_text("x")',
      'custom("/tmp/out").write_text("x")',
      'from pathlib import Path\nPath = custom\nPath("/tmp/out").write_text("x")',
      'import pathlib as pl\npl = custom\npl.Path("/tmp/out").write_text("x")',
      'import pathlib as pl\npl = custom.module\npl.Path("/tmp/out").write_text("x")'
    ]) {
      expect(analyzeScriptContent(code).findings?.[0]?.evidence).toMatchObject({ kind: 'write-path', rawPath: null, pathClass: 'unresolved' })
    }
  })

  it.each([
    ['Chinese before', "注释\nopen('x', 'w')", "open('x', 'w')"],
    ['emoji before', "# 😀\nopen('x', 'w')", "open('x', 'w')"],
    ['Unicode inside', "open('目录😀/x', 'w')", "open('目录😀/x', 'w')"],
    ['CRLF multiline', "open(\r\n '目录/文件',\r\n 'w')", "open(\r\n '目录/文件',\r\n 'w')"]
  ])('extracts exact Unicode snippet (%s)', (_name, code, expected) => {
    expect(analyzeScriptContent(code).findings?.[0]?.snippet).toBe(expected)
  })

  it.each(["__import__('socket')", "import importlib\nimportlib.import_module('requests')", "__import__('urllib.request')"])(
    'emits network evidence alongside dynamic-import for %s', (code) => {
      const findings = analyzeScriptContent(code).findings ?? []
      expect(findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ class: 'dynamic-import', evidence: expect.objectContaining({ kind: 'dynamic-import' }) }),
        expect.objectContaining({ class: 'network-api', evidence: expect.objectContaining({ kind: 'network', attr: 'dynamic-import' }) })
      ]))
    }
  )

  describe('A1 — os.system / subprocess / pty', () => {
    it('os.system produces the same pattern fact for all callers', () => {
      expectAnalysis("import os\nos.system('id')", true, { patternIds: ['A1'] })
      expectAnalysis("import os\nos.system('id')", false, { patternIds: ['A1'] })
    })

    it('subprocess.run produces a process-creation fact', () => {
      expectAnalysis("import subprocess\nsubprocess.run(['id'])", true, { patternIds: ['A1'] })
      expectAnalysis("import subprocess\nsubprocess.run(['id'])", false, { patternIds: ['A1'] })
    })

    it('pty.spawn → ask', () => {
      expectAnalysis("import pty\npty.spawn('/bin/sh')", true, { patternIds: ['A1'] })
    })
  })

  describe('A2 — destructive file ops', () => {
    it('shutil.rmtree → ask', () => {
      expectAnalysis("import shutil\nshutil.rmtree('tmp')", true, { patternIds: ['A2'] })
    })

    it('os.remove → ask', () => {
      expectAnalysis("import os\nos.remove('f.txt')", true, { patternIds: ['A2'] })
    })

    it('Path.unlink → ask', () => {
      expectAnalysis("from pathlib import Path\nPath('f').unlink()", true, { patternIds: ['A2'] })
    })
  })

  describe('A3 — eval / exec / compile', () => {
    it('eval → ask', () => {
      expectAnalysis("eval('1+1')", true, { patternIds: ['A3'] })
      expectAnalysis("eval('1+1')", false, { patternIds: ['A3'] })
    })

    it('exec → ask', () => {
      expectAnalysis("exec('pass')", true, { patternIds: ['A3'] })
    })

    it('dynamic variable / function result args still ask', () => {
      expectAnalysis('payload = input()\nexec(payload)', true, { patternIds: ['A3'] })
      expectAnalysis('source = get_code()\neval(source)', true, { patternIds: ['A3'] })
      expectAnalysis("source = user_value\ncompile(source, 'x', 'exec')", true, {
        patternIds: ['A3']
      })
    })

    it('builtins.eval / builtins.exec with dynamic args still ask', () => {
      expectAnalysis('import builtins\npayload = input()\nbuiltins.exec(payload)', true, {
        patternIds: ['A3']
      })
      expectAnalysis('import builtins\nsource = get_code()\nbuiltins.eval(source)', true, {
        patternIds: ['A3']
      })
      expectAnalysis("import builtins\nsource = user_value\nbuiltins.compile(source, 'x', 'exec')", true, {
        patternIds: ['A3']
      })
    })
  })

  describe('A4 — dynamic import of dangerous module', () => {
    it("__import__('os') → ask", () => {
      expectAnalysis("__import__('os')", true, { patternIds: ['A4'] })
      expectAnalysis("__import__('os')", false, { patternIds: ['A4'] })
    })

    it('importlib.import_module → ask', () => {
      expectAnalysis("import importlib\nimportlib.import_module('os')", true, { patternIds: ['A4'] })
    })
  })

  describe('A5 — ctypes / cffi native load', () => {
    it('ctypes.CDLL → deny', () => {
      expectAnalysis("import ctypes\nctypes.CDLL('libc.so.6')", true, { patternIds: ['A5'] })
      expectAnalysis("import ctypes\nctypes.CDLL('libc.so.6')", false, { patternIds: ['A5'] })
    })
  })

  describe('A6 — network outbound', () => {
    it('socket — deny remote, ask desktop', () => {
      expectAnalysis("import socket\nsocket.socket()", true, { patternIds: ['A6'] })
      expectAnalysis("import socket\nsocket.socket()", false, { patternIds: ['A6'] })
    })

    it('requests.get — deny remote, ask desktop', () => {
      expectAnalysis("import requests\nrequests.get('http://x')", true, { patternIds: ['A6'] })
      expectAnalysis("import requests\nrequests.get('http://x')", false, { patternIds: ['A6'] })
    })

    it('urllib.request.urlopen — deny remote, ask desktop', () => {
      expectAnalysis("import urllib.request\nurllib.request.urlopen('http://x')", true, { patternIds: ['A6'] })
    })
  })

  describe('A7 — absolute / dotdot write', () => {
    it('open absolute write → deny', () => {
      expectAnalysis("open('/etc/passwd', 'w')", true, { patternIds: ['A7'] })
      expectAnalysis("open('/etc/passwd', 'w')", false, { patternIds: ['A7'] })
    })

    it('open with .. → deny', () => {
      expectAnalysis("open('../secret', 'w')", true, { patternIds: ['A7'] })
    })

    it('Path.write_text absolute → deny', () => {
      expectAnalysis("from pathlib import Path\nPath('/tmp/x').write_text('hi')", true, { patternIds: ['A7'] })
    })
  })

  describe('A8 — relative cwd write (allow + audit)', () => {
    it('open relative write → allow with A8', () => {
      expectAnalysis("open('out.txt', 'w')", true, { patternIds: ['A8'] })
      expectAnalysis("open('out.txt', 'w')", false, { patternIds: ['A8'] })
    })

    it('Path.write_text relative → allow with A8', () => {
      expectAnalysis("from pathlib import Path\nPath('out.txt').write_text('hi')", true, { patternIds: ['A8'] })
    })
  })

  describe('A9 — os.chdir (allow + audit)', () => {
    it('os.chdir → allow with A9', () => {
      expectAnalysis("import os\nos.chdir('src')", true, { patternIds: ['A9'] })
      expectAnalysis("import os\nos.chdir('src')", false, { patternIds: ['A9'] })
    })
  })

  describe('A0 — safe script', () => {
    it('benign code yields no findings', () => {
      expectAnalysis('print(1 + 2)', true, { patternIds: [] })
      expectAnalysis('x = [i for i in range(3)]', false, { patternIds: [] })
    })
  })

  describe('Analysis coverage — parse failure', () => {
    it('unparseable returns failed coverage without findings', () => {
      const r = analyzeScriptContent('def foo(:\n  pass')
      expect(r).toMatchObject({ coverage: 'failed', findings: [], totalCount: 0 })
    })
  })

  describe('multi-category facts', () => {
    it('retains findings for both write and native-code-load categories', () => {
      const r = analyzeScriptContent("open('/x','w')\nimport ctypes\nctypes.CDLL('x')")
      expect(r.findings.map((finding) => finding.pattern)).toEqual(expect.arrayContaining(['A7', 'A5']))
    })
  })

  describe('WP3 — expanded process-creation capability facts', () => {
    it('os.spawn* family produces process-creation facts', () => {
      expectAnalysis("import os\nos.spawnv(0, '/bin/ls', ['ls'])", true, { patternIds: ['A1'] })
      expectAnalysis("import os\nos.spawnlp(0, 'ls', 'ls')", false, { patternIds: ['A1'] })
    })

    it('os.posix_spawn* family produces process-creation facts', () => {
      expectAnalysis("import os\nos.posix_spawn('/bin/ls', ['ls'], env)", true, {
        patternIds: ['A1']
      })
      expectAnalysis("import os\nos.posix_spawnp('ls', ['ls'], env)", true, { patternIds: ['A1'] })
    })

    it('asyncio subprocess calls produce process-creation facts', () => {
      expectAnalysis("import asyncio\nasyncio.create_subprocess_exec('ls')", true, {
        patternIds: ['A1']
      })
      expectAnalysis("import asyncio\nasyncio.create_subprocess_shell('ls')", true, {
        patternIds: ['A1']
      })
    })

    it('aliased imports of the process-creation family still ask', () => {
      const r1 = analyzeScriptContent("import os as o\no.spawnv(0, '/bin/ls', ['ls'])")
      expect(r1.findings.map((finding) => finding.pattern)).toContain('A1')
      expect(r1.findings.map((finding) => finding.pattern)).toContain('A1')

      const r2 = analyzeScriptContent("import asyncio as aio\naio.create_subprocess_exec('ls')")
      expect(r2.findings.map((finding) => finding.pattern)).toContain('A1')
      expect(r2.findings.map((finding) => finding.pattern)).toContain('A1')

      const r3 = analyzeScriptContent("from os import spawnv\nspawnv(0, '/bin/ls', ['ls'])")
      expect(r3.findings.map((finding) => finding.pattern)).toContain('A1')

      const r4 = analyzeScriptContent("from os import posix_spawn as ps\nps('/bin/ls', ['ls'], env)")
      expect(r4.findings.map((finding) => finding.pattern)).toContain('A1')
    })

    it('produces facts for every expanded process-creation family', () => {
      const scripts = [
        "import os\nos.spawnv(0, '/bin/ls', ['ls'])",
        "import os\nos.posix_spawn('/bin/ls', ['ls'], env)",
        "import asyncio\nasyncio.create_subprocess_exec('ls')",
        "import asyncio\nasyncio.create_subprocess_shell('ls')",
        "import subprocess\nsubprocess.run(['id'])",
        "import pty\npty.spawn('/bin/sh')"
      ]
      for (const code of scripts) {
        const r = analyzeScriptContent(code)
        expect(r.findings.length, code).toBeGreaterThan(0)
      }
    })
  })

})

describe('script uncertainty facts', () => {
  it.each([
    ['loop-carried dependency before next body read', 'from external_module import obj\nx = 1\ny = 1\nfor _ in [1, 2, 3]:\n    f"{x}"\n    x = y\n    y = obj'],
    ['loop-carried dependency at for exit', 'from external_module import obj\nx = 1\ny = 1\nfor _ in [1, 2]:\n    x = y\n    y = obj\nf"{x}"'],
    ['reverse assignment order still invalidates dependency', 'from external_module import obj\nx = 1\ny = 1\nfor _ in [1, 2]:\n    y = obj\n    x = y\nf"{x}"'],
    ['three-link dependency closure', 'from external_module import obj\nx = 1\ny = 1\nz = 1\nfor _ in [1, 2, 3]:\n    x = y\n    y = z\n    z = obj\nf"{x}"'],
    ['primitive increment loop remains fully modeled', 'total = 0\nfor item in [1, 2, 3]:\n    total += item\nf"{total}"'],
    ['for else overwrite at exit', 'from external_module import obj\nx = 1\nfor _ in [1]:\n    x = 1\nelse:\n    x = obj\nf"{x}"'],
    ['loop-carried dependency at while body read', 'from external_module import obj\nx = 1\ny = 1\nwhile True:\n    f"{x}"\n    x = y\n    y = obj']
  ])('fails closed for transitive loop invalidation: %s', (_label, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: 'implicit-call-unresolved' }))
  })

  it.each([
    ['assert message', 'assert False, __import__("os").system("id")'],
    ['raise cause', 'raise ValueError() from __import__("os").system("id")'],
    ['parameter annotation', 'def f(x: __import__("os").system("id")): pass'],
    ['return annotation', 'def f() -> __import__("os").system("id"): pass'],
    ['nested f-string format', `f"{42:{__import__('os').system('id')}}"`],
    ['f-string dictionary colon', `f"{ {'x': __import__('os').system('id')} }"`],
    ['shadowed primitive parameter', 'x = 1\ndef f(x):\n    return x + 1\nfrom external_module import obj\nf(obj)'],
    ['branch rebind', 'from external_module import obj\nx = 1\nif True:\n    x = obj\nf"{x}"'],
    ['loop rebind', 'from external_module import obj\nx = 1\nfor _ in [1]:\n    x = obj\nf"{x}"'],
    ['aliased mutable value mutation', 'from external_module import obj\na = [1]\nb = a\nb.append(obj)\nf"{a}"'],
    ['set element hash', 'from external_module import obj\nvalue = {obj}'],
    ['comprehension truthiness', 'from external_module import obj\n[i for i in [1] if obj]'],
    ['set comprehension hash', 'from external_module import obj\n{obj for i in [1]}'],
    ['dict comprehension key hash', 'from external_module import obj\n{obj: 1 for i in [1]}'],
    ['unpack iteration', 'from external_module import obj\na, b = obj'],
    ['chained unpack iteration', 'from external_module import obj\na = b, c = obj'],
    ['annotation-only preserves runtime binding', 'from external_module import obj\nx = obj\nx: int\nf"{x}"'],
    ['augmented assignment reads old receiver', 'from external_module import obj\nx = obj\nx += 1\nf"{x}"'],
    ['lambda parameter shadows primitive', 'x = 1\nf = lambda x: x + 1\nfrom external_module import obj\nf(obj)'],
    ['walrus block write invalidates outer binding', 'from external_module import obj\nx = 1\nif True:\n    (x := obj)\nf"{x}"'],
    ['for else write invalidates outer binding', 'from external_module import obj\nx = 1\nfor _ in []:\n    pass\nelse:\n    x = obj\nf"{x}"'],
    ['bare mutator invalidates container alias', 'from external_module import obj, mutate\na = [1]\nmutate(a, obj)\nf"{a}"'],
    ['for loop carried write before next iteration', 'from external_module import obj\nx = 1\nfor _ in [1, 2]:\n    f"{x}"\n    x = obj'],
    ['while loop carried write before next iteration', 'from external_module import obj\nx = 1\nwhile flag:\n    f"{x}"\n    x = obj'],
    ['mutable inside tuple passed to mutator', 'from external_module import obj, mutate\na = [1]\nt = (a,)\nmutate(t, obj)\nf"{a}"'],
    ['mutable inside literal wrapper passed to mutator', 'from external_module import obj, mutate\na = [1]\nmutate([a], obj)\nf"{a}"'],
    ['mutable inside starred wrapper passed to mutator', 'from external_module import obj, mutate\na = [1]\nt = (a,)\nmutate(*t, marker=obj)\nf"{a}"'],
    ['branch method effect reaches outer binding', 'from external_module import obj\na = [1]\nif True:\n    a.append(obj)\nf"{a}"'],
    ['function method effect reaches outer binding', 'from external_module import obj\na = [1]\ndef change():\n    a.append(obj)\nchange()\nf"{a}"'],
    ['sorted callback effect reaches outer binding', 'from external_module import obj\na = [1]\ndef key(x):\n    a.append(obj)\n    return 0\nsorted(a, key=key)\nf"{a}"'],
    ['rebound builtin name is not trusted', 'from external_module import obj, factory\nprint = factory()\na = [1]\nprint(a, obj)\nf"{a}"'],
    ['rebound builtin remains unknown without mutable argument', 'from external_module import obj, factory\nprint = factory()\na = [1]\nprint(obj)\nf"{a}"'],
    ['nested mutable allocation escapes', 'from external_module import obj, mutate\nt = ([1],)\nmutate(t, obj)\nf"{t}"'],
    ['conditional mutable allocation escapes', 'from external_module import obj, mutate\na = [1] if True else [2]\nmutate(a, obj)\nf"{a}"'],
    ['binary mutable allocation escapes', 'from external_module import obj, mutate\na = [1] + [2]\nmutate(a, obj)\nf"{a}"'],
    ['while next condition uses loop-carried value', 'from external_module import obj\nx = 1\nwhile x:\n    x = obj']
  ])('fails closed for systematic-review case: %s', (_label, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).not.toBe('complete')
    expect(result.findings.length + result.uncertainties.length).toBeGreaterThan(0)
  })

  it('does not trust a loop target as an imported module root', () => {
    const result = analyzeScriptContent('for x in range(3):\n    x()')
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'binding-origin-unknown' })]))
  })

  it.each([
    ['dynamic f-string formatting', 'f"{value}"'],
    ['dynamic subscript', 'value = obj[index]'],
    ['dynamic iteration', 'for item in source:\n    pass'],
    ['dynamic context manager', 'with manager():\n    pass'],
    ['overloaded arithmetic', 'value = left + right'],
    ['overloaded comparison', 'value = left < right'],
    ['dynamic truthiness', 'if value:\n    pass'],
    ['dynamic conditional truthiness', 'result = "yes" if value else "no"'],
    ['dynamic attribute descriptor', 'result = value.field'],
    ['dynamic mapping key hashing', 'mapping = {value: 1}'],
    ['dynamic attribute setter', 'value.field = 1']
  ])('reports uncertainty for implicit invocation: %s', (_label, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'implicit-call-unresolved', sourceStatus: 'unknown', dynamicAccess: true })]))
  })

  it('keeps literal and known builtin iteration operations complete', () => {
    for (const code of [
      'items = [1, 2]\nvalue = items[0]',
      'for value in range(3):\n    print(value)',
      'label = f"{42}"',
      'value = 1 + 2'
    ]) {
      const result = analyzeScriptContent(code)
      expect(result.coverage, code).toBe('complete')
      expect(result.uncertainties, code).toEqual([])
    }
  })

  it('keeps nested loop analysis work bounded and complete', async () => {
    await scriptParserService.ensureInitialized()
    const depth = 22
    const code = Array.from({ length: depth }, (_, index) => `${'    '.repeat(index)}for i in [1]:`)
      .concat(`${'    '.repeat(depth)}pass`).join('\n')
    const ir = parsePythonModule(code)
    const startedAt = performance.now()
    const result = analyzeScriptContent(code, ir)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(result.coverage).toBe('complete')
  })

  it.each([
    ['lambda rebound builtin name is not trusted', 'from external_module import obj\nprint = lambda *args: None\na = [1]\nprint(a, obj)\nf"{a}"'],
    ['function definition shadows trusted builtin', 'from external_module import obj\ndef print(*args):\n    return None\na = [1]\nprint(a, obj)\nf"{a}"'],
    ['branch rebind invalidates trusted builtin identity', 'from external_module import obj\nif flag:\n    print = lambda *args: None\na = [1]\nprint(a, obj)\nf"{a}"']
  ])('does not trust a rebound builtin with mutable arguments: %s', (_label, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: 'implicit-call-unresolved' }))
  })

  it('tracks both aliases produced by chained assignment before dangerous calls', () => {
    const code = "import os\nleft = right = os.system\nleft('id')\nright('id')"
    const ir = parsePythonModule(code)
    expect(ir.body[1]).toMatchObject({ kind: 'assign', targets: ['left', 'right'] })
    const result = analyzeScriptContent(code, ir)
    expect(result.findings.filter((finding) => finding.class === 'process-creation')).toHaveLength(2)
  })

  it('reports a stable uncertainty for unresolved calls instead of complete clean facts', () => {
    const result = analyzeScriptContent('factory()()')
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toEqual([expect.objectContaining({ kind: 'call-target-unresolved', sourceStatus: 'unresolved', range: expect.any(Object) })])
  })

  it.each([
    ['while statement', 'while True:\n    pass'],
    ['literal f-string', 'value = f"{42}"'],
    ['with statement', 'with open("data.txt") as f:\n    data = f.read()'],
    ['function definition', 'def helper(x):\n    return 1 * 2\nprint(helper(3))'],
    ['literal conditional expression', 'value = "yes" if True else "no"'],
    ['literal subscript', 'items = [1, 2, 3]\nitem = items[0]'],
    ['dynamic import target', 'import importlib\nimportlib.import_module(module_name)'],
    ['unclassified dangerous call', 'import os\nos.getcwd()', 'unclassified-dangerous-call'],
    ['unknown reflection target', 'getattr(obj, name)', 'reflection-target-unresolved']
  ] as const)('%s does not become incomplete solely from a supported IR shape', (_name, code) => {
    const result = analyzeScriptContent(code)
    if (_name === 'dynamic import target' || _name === 'unclassified dangerous call' || _name === 'unknown reflection target') {
      expect(result.coverage).toBe('partial')
      const expectedKind = _name === 'dynamic import target' ? 'dynamic-import-target-unresolved'
        : _name === 'unclassified dangerous call' ? 'unclassified-dangerous-call' : 'reflection-target-unresolved'
      expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: expectedKind, range: expect.any(Object) }))
    } else {
      expect(result.coverage, result.reason).toBe('complete')
      expect(result.uncertainties).toEqual([])
    }
  })

  it('continues after one certification failure and records every distinct incomplete site', () => {
    const result = analyzeScriptContent('import os\nos.getcwd()\nvalue = getattr(obj, name)')
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties.map((item) => item.kind)).toEqual(expect.arrayContaining([
      'unclassified-dangerous-call', 'reflection-target-unresolved'
    ]))
  })

  it('represents an unclassified call for every dangerous module root', () => {
    for (const root of DANGEROUS_MODULES) {
      const result = analyzeScriptContent(`import ${root}\n${root}.unmodeled_capability()`)
      expect(result.findings.length + result.uncertainties.length, root).toBeGreaterThan(0)
      if (result.findings.length === 0) {
        expect(result.uncertainties, root).toContainEqual(expect.objectContaining({ kind: 'unclassified-dangerous-call' }))
      }
    }
  })

  it('records an unresolved computed callee when the IR carries no statically resolvable root', () => {
    const ir = parsePythonModule('f()')
    const statement = ir.body[0]
    if (!statement || statement.kind !== 'expr' || statement.value.kind !== 'call') throw new Error('expected call expression IR')
    statement.value.callee = { kind: 'none', range: statement.value.callee.range }
    const result = analyzeScriptContent('f()', ir)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: 'call-target-unresolved', sourceStatus: 'unresolved' }))
  })

  it.each([
    ['unknown binding origin', '(left + right).run()', 'binding-origin-unknown'],
    ['dangerous capability without a modeled effect', 'import os\nos.getcwd()', 'unclassified-dangerous-call'],
    ['unresolved reflection target', 'getattr(obj, name)', 'reflection-target-unresolved'],
    ['unresolved dynamic import target', 'import importlib\nimportlib.import_module(name)', 'dynamic-import-target-unresolved']
  ])('maps script uncertainty collector branch: %s', (_label, code, kind) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind, range: expect.any(Object) }))
  })

  it('maps unknown future IR statement and expression variants to explicit partial facts', () => {
    const statementIr = parsePythonModule('pass')
    statementIr.body[0] = { kind: 'future_statement', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 } } as never
    const statementResult = analyzeScriptContent('pass', statementIr)
    expect(statementResult.coverage).toBe('partial')
    expect(statementResult.uncertainties).toContainEqual(expect.objectContaining({ kind: 'unmodeled-statement' }))

    const expressionIr = parsePythonModule('f()')
    const expressionStatement = expressionIr.body[0]
    if (!expressionStatement || expressionStatement.kind !== 'expr') throw new Error('expected expression statement')
    expressionStatement.value = { kind: 'future_expression', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 4 } } as never
    const expressionResult = analyzeScriptContent('f()', expressionIr)
    expect(expressionResult.coverage).toBe('partial')
    expect(expressionResult.uncertainties).toContainEqual(expect.objectContaining({ kind: 'unmodeled-expression' }))
  })
})

describe('D3 行为类别补齐', () => {
  it.each([
    ['multiprocessing.pool.Pool', 'from multiprocessing.pool import Pool\nPool(2)', 'process-creation'],
    ['xmlrpc.client.ServerProxy', 'from xmlrpc.client import ServerProxy\nServerProxy("https://example.test").ping()', 'network-api'],
    ['concurrent.futures.ProcessPoolExecutor', 'from concurrent.futures import ProcessPoolExecutor\nProcessPoolExecutor()', 'process-creation'],
    ['concurrent.futures.process.ProcessPoolExecutor', 'from concurrent.futures.process import ProcessPoolExecutor\nProcessPoolExecutor()', 'process-creation']
  ] as const)('classifies child-module capability %s as %s', (_name, code, expected) => {
    expect(analyzeScriptContent(code).findings.map((finding) => finding.class)).toContain(expected)
  })

  it.each([
    ['nested if assignment', 'from external_module import obj\nif True:\n    obj.field = 1'],
    ['nested augmented assignment', 'from external_module import obj\ndef f():\n    obj.field += 1'],
    ['nested delete', 'from external_module import obj\ntry:\n    del obj.field\nexcept Exception:\n    pass']
  ] as const)('marks %s as implicit behavior uncertainty', (_name, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: 'implicit-call-unresolved' }))
  })

  it.each([
    ['alias call', 'def f(x):\n    return x + 1\nf(1)\ng = f\ng(obj)'],
    ['callback escape', 'def f(x):\n    return x + 1\nf(1)\nregister(f)'],
    ['rebound function name', 'def f(x):\n    return x + 1\nf(1)\nf = other\nf(obj)'],
    ['aliased lambda call', 'f = lambda x: x + 1\nf(1)\ng = f\ng(obj)']
  ] as const)('does not use a direct call to prove parameters primitive after %s', (_name, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: 'implicit-call-unresolved' }))
  })

  it.each([
    ['multiprocessing.Process', 'import multiprocessing\nmultiprocessing.Process(target=print)', 'process-creation'],
    ['ProcessPoolExecutor', 'from concurrent.futures import ProcessPoolExecutor\nProcessPoolExecutor()', 'process-creation'],
    ['pickle.load', 'import pickle\npickle.load(stream)', 'dynamic-execution'],
    ['marshal.loads', 'import marshal\nmarshal.loads(data)', 'dynamic-execution'],
    ['ftplib', 'import ftplib\nftplib.FTP(host)', 'network-api'],
    ['smtplib', 'import smtplib\nsmtplib.SMTP(host)', 'network-api'],
    ['xmlrpc', 'import xmlrpc.client\nxmlrpc.client.ServerProxy(url)', 'network-api'],
    ['telnetlib', 'import telnetlib\ntelnetlib.Telnet(host)', 'network-api']
  ] as const)('%s produces %s finding', (_name, code, findingClass) => {
    expect(analyzeScriptContent(code).findings.map((finding) => finding.class)).toContain(findingClass)
  })

  it('does not label ThreadPoolExecutor as process creation', () => {
    expect(analyzeScriptContent('from concurrent.futures import ThreadPoolExecutor\nThreadPoolExecutor()').findings.map((finding) => finding.class)).not.toContain('process-creation')
  })
})

describe('隐式调用完整性复审 R1-R3', () => {
  it.each([
    ['sorted 未知默认参数', 'from external_module import obj\nsorted([1], key=lambda x, y=obj: y + 1)'],
    ['sorted 调用后的绑定', 'from external_module import obj\nx = obj\nsorted(x, key=lambda item: item + 1)\nx = [1]'],
    ['sorted 被遮蔽', 'from external_module import obj\nsorted = obj\nsorted([1], key=lambda item: item + 1)']
  ] as const)('%s 不会证明 lambda 参数是原始值', (_label, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: 'implicit-call-unresolved' }))
  })

  it.each([
    ['list index protocol', 'from external_module import obj\nvalue = [1]\nvalue[obj]'],
    ['dict key protocol', 'from external_module import obj\nvalue = {1: 2}\nvalue[obj]'],
    ['slice boundary protocol', 'from external_module import obj\nvalue = [1, 2]\nvalue[obj:2]'],
    ['indexed assignment protocol', 'items = [1]\nitems[0] = 2'],
    ['indexed augmented assignment protocol', 'items = [1]\nitems[0] += 2'],
    ['indexed deletion protocol', 'items = [1]\ndel items[0]']
  ] as const)('%s 被记为隐式调用不确定事实', (_label, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: 'implicit-call-unresolved' }))
  })

  it.each([
    ['bare function decorator', 'from external_module import decorator\n@decorator\ndef f():\n    pass'],
    ['decorator factory', 'from external_module import decorator\n@decorator()\ndef f():\n    pass'],
    ['class decorator', 'from external_module import decorator\n@decorator\nclass C:\n    pass'],
    ['unknown class base', 'from external_module import base\nclass C(base):\n    pass']
  ] as const)('%s 在定义/创建时形成隐式调用不确定事实', (_label, code) => {
    const result = analyzeScriptContent(code)
    expect(result.coverage).toBe('partial')
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ kind: 'implicit-call-unresolved' }))
  })

  it('保留纯字面量内置容器索引的完整分析', () => {
    const result = analyzeScriptContent('items = [1, 2]\nvalue = items[0]')
    expect(result.coverage).toBe('complete')
    expect(result.uncertainties).toEqual([])
  })
})
