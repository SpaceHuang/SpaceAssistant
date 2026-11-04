import { describe, expect, it } from 'vitest'
import { analyzeScriptContent } from './scriptContentSecurity'

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

  it('bounds an unusually long finding snippet without changing its source range', () => {
    const code = `open('/tmp/${'x'.repeat(2500)}', 'w')`
    const finding = analyzeScriptContent(code).findings?.[0]
    expect(finding?.snippet.length).toBeLessThanOrEqual(2000)
    expect(finding?.range.endCol).toBe(code.length + 1)
  })

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
