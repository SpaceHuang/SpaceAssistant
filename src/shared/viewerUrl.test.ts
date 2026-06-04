import { describe, expect, it } from 'vitest'
import { isHtmlExtension, isHtmlFile, normalizeViewerUrl } from './viewerUrl'

describe('viewerUrl', () => {
  describe('normalizeViewerUrl', () => {
    it('returns null for empty input', () => {
      expect(normalizeViewerUrl('')).toBeNull()
      expect(normalizeViewerUrl('   ')).toBeNull()
    })

    it('prepends https for bare domains', () => {
      expect(normalizeViewerUrl('example.com')).toBe('https://example.com/')
    })

    it('accepts localhost with port', () => {
      expect(normalizeViewerUrl('http://localhost:3000/path')).toBe('http://localhost:3000/path')
    })

    it('accepts IP with port', () => {
      expect(normalizeViewerUrl('192.168.1.1:8080')).toBe('https://192.168.1.1:8080/')
    })

    it('accepts file protocol', () => {
      expect(normalizeViewerUrl('file:///C:/tmp/page.html')).toBe('file:///C:/tmp/page.html')
    })

    it('rejects unsupported protocols', () => {
      expect(normalizeViewerUrl('javascript:alert(1)')).toBeNull()
      expect(normalizeViewerUrl('ftp://example.com')).toBeNull()
    })
  })

  describe('isHtmlExtension', () => {
    it('matches html family extensions', () => {
      expect(isHtmlExtension('.html')).toBe(true)
      expect(isHtmlExtension('.htm')).toBe(true)
      expect(isHtmlExtension('.xhtml')).toBe(true)
      expect(isHtmlExtension('.mhtml')).toBe(false)
    })
  })

  describe('isHtmlFile', () => {
    it('detects html paths', () => {
      expect(isHtmlFile('pages/index.html')).toBe(true)
      expect(isHtmlFile('pages\\index.htm')).toBe(true)
      expect(isHtmlFile('readme.md')).toBe(false)
    })
  })
})
