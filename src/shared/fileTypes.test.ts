import { describe, expect, it } from 'vitest'
import { classifyFileType, extToShikiLang, getFileExtension, isUnsupportedExtension } from './fileTypes'

describe('fileTypes', () => {
  it('extracts extension', () => {
    expect(getFileExtension('src/utils/helper.ts')).toBe('.ts')
    expect(getFileExtension('README')).toBe('')
  })

  it('classifies markdown', () => {
    expect(classifyFileType('docs/readme.md')).toBe('markdown')
  })

  it('classifies code', () => {
    expect(classifyFileType('src/app.tsx')).toBe('code')
  })

  it('classifies image', () => {
    expect(classifyFileType('assets/logo.png')).toBe('image')
  })

  it('classifies unsupported', () => {
    expect(classifyFileType('file.pdf')).toBe('unsupported')
    expect(isUnsupportedExtension('.pdf')).toBe(true)
  })

  it('maps extension to shiki lang', () => {
    expect(extToShikiLang('app.tsx')).toBe('tsx')
    expect(extToShikiLang('unknown')).toBe('plaintext')
  })
})
