import { describe, expect, it } from 'vitest'
import { analyzeScriptContent } from './scriptContentSecurity'

type Expectation = {
  verdict: 'allow' | 'ask' | 'deny'
  patterns?: string[]
}

function expectAnalysis(code: string, remote: boolean | undefined, exp: Expectation): void {
  const r = analyzeScriptContent(code, remote === undefined ? undefined : { remote })
  expect(r.verdict).toBe(exp.verdict)
  if (exp.patterns) {
    for (const p of exp.patterns) {
      expect(r.patterns).toContain(p)
    }
  }
}

describe('scriptContentSecurity — List A (baseline)', () => {
  describe('A1 — os.system / subprocess / pty', () => {
    it('os.system → ask (remote & desktop)', () => {
      expectAnalysis("import os\nos.system('id')", true, { verdict: 'ask', patterns: ['A1'] })
      expectAnalysis("import os\nos.system('id')", false, { verdict: 'ask', patterns: ['A1'] })
    })

    it('subprocess.run → ask', () => {
      expectAnalysis("import subprocess\nsubprocess.run(['id'])", true, { verdict: 'ask', patterns: ['A1'] })
      expectAnalysis("import subprocess\nsubprocess.run(['id'])", false, { verdict: 'ask', patterns: ['A1'] })
    })

    it('pty.spawn → ask', () => {
      expectAnalysis("import pty\npty.spawn('/bin/sh')", true, { verdict: 'ask', patterns: ['A1'] })
    })
  })

  describe('A2 — destructive file ops', () => {
    it('shutil.rmtree → ask', () => {
      expectAnalysis("import shutil\nshutil.rmtree('tmp')", true, { verdict: 'ask', patterns: ['A2'] })
    })

    it('os.remove → ask', () => {
      expectAnalysis("import os\nos.remove('f.txt')", true, { verdict: 'ask', patterns: ['A2'] })
    })

    it('Path.unlink → ask', () => {
      expectAnalysis("from pathlib import Path\nPath('f').unlink()", true, { verdict: 'ask', patterns: ['A2'] })
    })
  })

  describe('A3 — eval / exec / compile', () => {
    it('eval → ask', () => {
      expectAnalysis("eval('1+1')", true, { verdict: 'ask', patterns: ['A3'] })
      expectAnalysis("eval('1+1')", false, { verdict: 'ask', patterns: ['A3'] })
    })

    it('exec → ask', () => {
      expectAnalysis("exec('pass')", true, { verdict: 'ask', patterns: ['A3'] })
    })

    it('dynamic variable / function result args still ask', () => {
      expectAnalysis('payload = input()\nexec(payload)', true, { verdict: 'ask', patterns: ['A3'] })
      expectAnalysis('source = get_code()\neval(source)', true, { verdict: 'ask', patterns: ['A3'] })
      expectAnalysis("source = user_value\ncompile(source, 'x', 'exec')", true, {
        verdict: 'ask',
        patterns: ['A3']
      })
    })

    it('builtins.eval / builtins.exec with dynamic args still ask', () => {
      expectAnalysis('import builtins\npayload = input()\nbuiltins.exec(payload)', true, {
        verdict: 'ask',
        patterns: ['A3']
      })
      expectAnalysis('import builtins\nsource = get_code()\nbuiltins.eval(source)', true, {
        verdict: 'ask',
        patterns: ['A3']
      })
      expectAnalysis("import builtins\nsource = user_value\nbuiltins.compile(source, 'x', 'exec')", true, {
        verdict: 'ask',
        patterns: ['A3']
      })
    })
  })

  describe('A4 — dynamic import of dangerous module', () => {
    it("__import__('os') → ask", () => {
      expectAnalysis("__import__('os')", true, { verdict: 'ask', patterns: ['A4'] })
      expectAnalysis("__import__('os')", false, { verdict: 'ask', patterns: ['A4'] })
    })

    it('importlib.import_module → ask', () => {
      expectAnalysis("import importlib\nimportlib.import_module('os')", true, { verdict: 'ask', patterns: ['A4'] })
    })
  })

  describe('A5 — ctypes / cffi native load', () => {
    it('ctypes.CDLL → deny', () => {
      expectAnalysis("import ctypes\nctypes.CDLL('libc.so.6')", true, { verdict: 'deny', patterns: ['A5'] })
      expectAnalysis("import ctypes\nctypes.CDLL('libc.so.6')", false, { verdict: 'deny', patterns: ['A5'] })
    })
  })

  describe('A6 — network outbound', () => {
    it('socket — deny remote, ask desktop', () => {
      expectAnalysis("import socket\nsocket.socket()", true, { verdict: 'deny', patterns: ['A6'] })
      expectAnalysis("import socket\nsocket.socket()", false, { verdict: 'ask', patterns: ['A6'] })
    })

    it('requests.get — deny remote, ask desktop', () => {
      expectAnalysis("import requests\nrequests.get('http://x')", true, { verdict: 'deny', patterns: ['A6'] })
      expectAnalysis("import requests\nrequests.get('http://x')", false, { verdict: 'ask', patterns: ['A6'] })
    })

    it('urllib.request.urlopen — deny remote, ask desktop', () => {
      expectAnalysis("import urllib.request\nurllib.request.urlopen('http://x')", true, { verdict: 'deny', patterns: ['A6'] })
    })
  })

  describe('A7 — absolute / dotdot write', () => {
    it('open absolute write → deny', () => {
      expectAnalysis("open('/etc/passwd', 'w')", true, { verdict: 'deny', patterns: ['A7'] })
      expectAnalysis("open('/etc/passwd', 'w')", false, { verdict: 'deny', patterns: ['A7'] })
    })

    it('open with .. → deny', () => {
      expectAnalysis("open('../secret', 'w')", true, { verdict: 'deny', patterns: ['A7'] })
    })

    it('Path.write_text absolute → deny', () => {
      expectAnalysis("from pathlib import Path\nPath('/tmp/x').write_text('hi')", true, { verdict: 'deny', patterns: ['A7'] })
    })
  })

  describe('A8 — relative cwd write (allow + audit)', () => {
    it('open relative write → allow with A8', () => {
      expectAnalysis("open('out.txt', 'w')", true, { verdict: 'allow', patterns: ['A8'] })
      expectAnalysis("open('out.txt', 'w')", false, { verdict: 'allow', patterns: ['A8'] })
    })

    it('Path.write_text relative → allow with A8', () => {
      expectAnalysis("from pathlib import Path\nPath('out.txt').write_text('hi')", true, { verdict: 'allow', patterns: ['A8'] })
    })
  })

  describe('A9 — os.chdir (allow + audit)', () => {
    it('os.chdir → allow with A9', () => {
      expectAnalysis("import os\nos.chdir('src')", true, { verdict: 'allow', patterns: ['A9'] })
      expectAnalysis("import os\nos.chdir('src')", false, { verdict: 'allow', patterns: ['A9'] })
    })
  })

  describe('A0 — safe script', () => {
    it('benign code → allow', () => {
      expectAnalysis('print(1 + 2)', true, { verdict: 'allow', patterns: ['A0'] })
      expectAnalysis('x = [i for i in range(3)]', false, { verdict: 'allow', patterns: ['A0'] })
    })
  })

  describe('A-fail — parse failure', () => {
    it('unparseable → ask with A-fail', () => {
      const r = analyzeScriptContent('def foo(:\n  pass', { remote: true })
      expect(r.verdict).toBe('ask')
      expect(r.patterns).toContain('A-fail')
    })
  })

  describe('verdict priority', () => {
    it('deny beats ask beats allow', () => {
      const r = analyzeScriptContent("open('/x','w')\nimport ctypes\nctypes.CDLL('x')", { remote: true })
      expect(r.verdict).toBe('deny')
      expect(r.patterns).toContain('A7')
      expect(r.patterns).toContain('A5')
    })
  })
})
