import { describe, expect, it } from 'vitest'
import { analyzeScriptContent } from './scriptContentSecurity'

function mustNotAllow(code: string, pattern: string, remote = false): void {
  const r = analyzeScriptContent(code, { remote })
  expect(r.verdict, `${pattern}: ${code}`).not.toBe('allow')
  expect(r.patterns, `${pattern}: ${code}`).toContain(pattern)
}

describe('scriptContentSecurity — List B (must ask or deny)', () => {
  it('B1 — getattr(os, "system")', () => {
    mustNotAllow("import os\ngetattr(os, 'system')('id')", 'B1')
    mustNotAllow("import os\ngetattr(os, 'popen')", 'B1')
  })

  it('B2 — getattr(__import__("os"), "system")', () => {
    mustNotAllow("getattr(__import__('os'), 'system')('id')", 'B2')
  })

  it('B3 — folded __import__ and attr (fold gate)', () => {
    mustNotAllow("getattr(__import__('o'+'s'), 'sys'+'tem')('id')", 'B3')
  })

  it('B4 — import_module fold then .system', () => {
    mustNotAllow("import importlib\nm = importlib.import_module('o'+'s')\nm.system('id')", 'B4')
  })

  it('B5 — import alias o.system', () => {
    mustNotAllow("import os as o\no.system('id')", 'B5')
    mustNotAllow("import subprocess as sp\nsp.run(['id'])", 'B5')
  })

  it('B6 — from os import system; system()', () => {
    mustNotAllow("from os import system\nsystem('id')", 'B6')
    mustNotAllow("from os import remove\nremove('f')", 'B6')
  })

  it('B7 — from os import system as s; s()', () => {
    mustNotAllow("from os import system as s\ns('id')", 'B7')
  })

  it('B8 — builtins.__import__ / exec / getattr', () => {
    mustNotAllow("import builtins\nbuiltins.__import__('os')", 'B8')
    mustNotAllow("import builtins\nbuiltins.exec('pass')", 'B8')
    mustNotAllow("import builtins\nbuiltins.getattr(os, 'system')", 'B8')
  })

  it('B9 — getattr unknown base with literal dangerous attr', () => {
    mustNotAllow("getattr(x, 'system')", 'B9')
    mustNotAllow("hasattr(unknown, 'eval')", 'B9')
  })

  it('B10 — dangerous import without call', () => {
    mustNotAllow("__import__('os')", 'B10')
    mustNotAllow("import importlib\nimportlib.import_module('subprocess')", 'B10')
    const r = analyzeScriptContent("import importlib\nimportlib.import_module('socket')", { remote: true })
    expect(r.verdict).toBe('deny')
    expect(r.patterns).toContain('B10')
  })

  it('B11 — decode → exec within window', () => {
    mustNotAllow("import base64\neval(base64.b64decode('cGFzcw=='))", 'B11')
    mustNotAllow("import base64\nt = base64.b64decode('cGFzcw==')\nexec(t)", 'B11')
    mustNotAllow("import codecs\nt = codecs.decode(b'x', 'utf-8')\ncompile(t, '<s>', 'exec')", 'B11')
    mustNotAllow("t = bytes.fromhex('70617373')\n__import__(t)", 'B11')
  })

  it('assignment rebind of dangerous module / callable must not allow', () => {
    mustNotAllow("import os\nx = os\nx.system('id')", 'A1')
    mustNotAllow("import os\ny = os.system\ny('id')", 'A1')
    mustNotAllow("import os as o\nx = o\nx.system('id')", 'A1')
    mustNotAllow("from os import system as s\nz = s\nz('id')", 'A1')
  })

  it('never allows any B pattern', () => {
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
      const r = analyzeScriptContent(code, { remote: false })
      expect(r.verdict, id).not.toBe('allow')
    }
  })
})
