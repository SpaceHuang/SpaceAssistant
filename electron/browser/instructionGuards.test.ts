import { describe, expect, it } from 'vitest'
import { assertAtomicAct, assertSafeInstruction } from './instructionGuards'

describe('assertSafeInstruction', () => {
  it('allows normal extract', () => {
    expect(() => assertSafeInstruction('extract the main content', 'extract')).not.toThrow()
  })

  it('allows normal observe', () => {
    expect(() => assertSafeInstruction('find all buttons', 'observe')).not.toThrow()
  })

  it('allows empty observe', () => {
    expect(() => assertSafeInstruction(undefined, 'observe')).not.toThrow()
  })

  it('allows single-step act in English', () => {
    expect(() => assertSafeInstruction('Click the Submit button', 'act')).not.toThrow()
  })

  it('allows single-step act in Chinese', () => {
    expect(() => assertSafeInstruction('点击提交按钮', 'act')).not.toThrow()
  })

  it('allows max length boundary', () => {
    expect(() => assertSafeInstruction('x'.repeat(1024), 'act')).not.toThrow()
  })

  it('rejects too long instruction', () => {
    expect(() => assertSafeInstruction('x'.repeat(1025), 'act')).toThrow(/指令过长/)
  })

  it('rejects NUL byte', () => {
    expect(() => assertSafeInstruction('click\0btn', 'act')).toThrow(/空字节/)
  })

  it('rejects evaluate', () => {
    expect(() => assertSafeInstruction('evaluate document.cookie', 'act')).toThrow(/禁止子串/)
  })

  it('rejects agent(', () => {
    expect(() => assertSafeInstruction('run agent(task)', 'act')).toThrow(/禁止子串/)
  })

  it('rejects page.', () => {
    expect(() => assertSafeInstruction('page.evaluate(...)', 'act')).toThrow(/禁止子串/)
  })

  it('rejects require(', () => {
    expect(() => assertSafeInstruction("require('fs')", 'act')).toThrow(/禁止子串/)
  })

  it('rejects import(', () => {
    expect(() => assertSafeInstruction("import('fs')", 'act')).toThrow(/禁止子串/)
  })

  it('rejects case variant Page.Evaluate', () => {
    expect(() => assertSafeInstruction('Page.Evaluate', 'act')).toThrow(/禁止子串/)
  })

  it('rejects javascript:', () => {
    expect(() => assertSafeInstruction('use javascript:void(0)', 'act')).toThrow(/禁止子串/)
  })

  it('rejects data:', () => {
    expect(() => assertSafeInstruction('navigate to data:text/html', 'act')).toThrow(/禁止子串/)
  })

  it('rejects vbscript:', () => {
    expect(() => assertSafeInstruction('run vbscript:msgbox', 'act')).toThrow(/禁止子串/)
  })
})

describe('assertAtomicAct', () => {
  const cases = [
    '打开页面然后点击按钮',
    'click A 并且 type B',
    'click A 之后 click B',
    'click A 接着 click B',
    'click A 然后再 click B',
    'click A 接着就 click B',
    'click A 随后 click B',
    'click A 下一步 click B',
    'click A 接下来 click B',
    'click A 继而 click B',
    'click A and then click B',
    'click A then click B',
    'click A after that click B',
    'click A followed by click B',
    'click A; click B',
    'click A && click B',
    'click A || click B',
    'click A | click B',
    'click A\nclick B'
  ]

  for (const instr of cases) {
    it(`rejects multi-step: ${instr.slice(0, 20)}`, () => {
      expect(() => assertAtomicAct(instr)).toThrow(/单步操作/)
    })
  }

  it('does not false-positive on lengthen', () => {
    expect(() => assertAtomicAct('Click the lengthen button')).not.toThrow()
  })

  it('allows complex single step', () => {
    expect(() =>
      assertAtomicAct('Click the blue Submit button in the top right corner of the form')
    ).not.toThrow()
  })
})
