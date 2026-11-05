import { describe, expect, it } from 'vitest'
import { analyzeScriptContent } from './scriptContentSecurity'

function mustFind(code: string, pattern: string): void {
  const result = analyzeScriptContent(code)
  expect(result.findings.map((finding) => finding.pattern)).toContain(pattern)
}

describe('scriptContentSecurity — List B (structural facts)', () => {
  it('B1 — getattr(os, "system")', () => {
    mustFind("import os\ngetattr(os, 'system')('id')", 'B1')
    mustFind("import os\ngetattr(os, 'popen')", 'B1')
  })

  it('B2 — getattr(__import__("os"), "system")', () => {
    mustFind("getattr(__import__('os'), 'system')('id')", 'B2')
  })

  it('B3 — folded __import__ and attr (fold gate)', () => {
    mustFind("getattr(__import__('o'+'s'), 'sys'+'tem')('id')", 'B3')
  })

  it('B4 — import_module fold then .system', () => {
    mustFind("import importlib\nm = importlib.import_module('o'+'s')\nm.system('id')", 'B4')
  })

  it('B5 — import alias o.system', () => {
    mustFind("import os as o\no.system('id')", 'B5')
    mustFind("import subprocess as sp\nsp.run(['id'])", 'B5')
  })

  it('B6 — from os import system; system()', () => {
    mustFind("from os import system\nsystem('id')", 'B6')
    mustFind("from os import remove\nremove('f')", 'B6')
  })

  it('B7 — from os import system as s; s()', () => {
    mustFind("from os import system as s\ns('id')", 'B7')
  })

  it('B8 — builtins.__import__ / exec / getattr', () => {
    mustFind("import builtins\nbuiltins.__import__('os')", 'B8')
    mustFind("import builtins\nbuiltins.exec('pass')", 'B8')
    mustFind("import builtins\nbuiltins.getattr(os, 'system')", 'B8')
  })

  it('B9 — getattr unknown base with literal dangerous attr', () => {
    mustFind("getattr(x, 'system')", 'B9')
    mustFind("hasattr(unknown, 'eval')", 'B9')
  })

  it('B10 — dangerous import without call', () => {
    mustFind("__import__('os')", 'B10')
    mustFind("import importlib\nimportlib.import_module('subprocess')", 'B10')
    const r = analyzeScriptContent("import importlib\nimportlib.import_module('socket')")
    expect(r.findings.map((finding) => finding.pattern)).toContain('B10')
  })

  it('B11 — decode → exec within window', () => {
    mustFind("import base64\neval(base64.b64decode('cGFzcw=='))", 'B11')
    mustFind("import base64\nt = base64.b64decode('cGFzcw==')\nexec(t)", 'B11')
    mustFind("import codecs\nt = codecs.decode(b'x', 'utf-8')\ncompile(t, '<s>', 'exec')", 'B11')
    mustFind("t = bytes.fromhex('70617373')\n__import__(t)", 'B11')
  })

  it('assignment rebind of dangerous module / callable must not allow', () => {
    mustFind("import os\nx = os\nx.system('id')", 'A1')
    mustFind("import os\ny = os.system\ny('id')", 'A1')
    mustFind("import os as o\nx = o\nx.system('id')", 'A1')
    mustFind("from os import system as s\nz = s\nz('id')", 'A1')
  })

  it('produces a finding for every B pattern fixture', () => {
    const fixtures: [string, string][] = [
      ["import os\ngetattr(os, 'system')", 'B1'],
      ["getattr(__import__('os'), 'system')", 'B2'],
      ["getattr(__import__('o'+'s'), 'sys'+'tem')", 'B3'],
      ["import os as o\no.system('id')", 'B5'],
      ["from os import system\nsystem('id')", 'B6'],
      ["from os import system as s\ns('id')", 'B7'],
      ["getattr(x, 'system')", 'B9'],
      ["__import__('os')", 'B10'],
      ["import base64\neval(base64.b64decode('eA=='))", 'B11']
    ]
    for (const [code, id] of fixtures) {
      const r = analyzeScriptContent(code)
      expect(r.findings.map((finding) => finding.pattern), id).toContain(id)
    }
  })
})
