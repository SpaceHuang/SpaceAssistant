import { describe, expect, it } from 'vitest'
import {
  parseShellSegments,
  parseSimpleShellCommand,
  tokenizeShellArgv,
  commandHasShellMetasyntax
} from './shellCommandParser'

describe('shellCommandParser', () => {
  it('splits && segments', () => {
    expect(parseShellSegments('npm install && npm test')).toEqual(['npm install', 'npm test'])
  })

  it('splits pipe outside quotes', () => {
    expect(parseShellSegments('git status | head')).toEqual(['git status', 'head'])
  })

  it('preserves quotes', () => {
    expect(parseShellSegments('"a && b" || c')).toEqual(['"a && b"', 'c'])
  })

  it('rejects too many segments', () => {
    const parts = Array.from({ length: 51 }, (_, i) => `echo ${i}`).join(' && ')
    expect(() => parseShellSegments(parts)).toThrow(/段数过多/)
  })

  it('tokenizes quoted argv', () => {
    expect(tokenizeShellArgv('echo "hello world"')).toEqual(['echo', 'hello world'])
    expect(tokenizeShellArgv("echo 'a b'")).toEqual(['echo', 'a b'])
  })

  it('parseSimpleShellCommand marks simple persistable', () => {
    const p = parseSimpleShellCommand('npm test')
    expect(p.persistable).toBe(true)
    expect(p.executable).toBe('npm')
    expect(p.argv).toEqual(['npm', 'test'])
    expect(p.hasMetasyntax).toBe(false)
  })

  it('parseSimpleShellCommand rejects metasyntax and multi-command', () => {
    expect(parseSimpleShellCommand('npm test && echo x').persistable).toBe(false)
    expect(parseSimpleShellCommand('npm test | cat').persistable).toBe(false)
    expect(parseSimpleShellCommand('echo x > f').persistable).toBe(false)
    expect(commandHasShellMetasyntax('echo x > f')).toBe(true)
  })
})
