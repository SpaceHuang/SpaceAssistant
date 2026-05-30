import { describe, expect, it } from 'vitest'
import { resolveCdpWebSocketUrl } from './playwrightBrowserHost'

describe('resolveCdpWebSocketUrl', () => {
  it('times out when no browser listens on port', async () => {
    const port = await new Promise<number>((resolve) => {
      const { createServer } = require('node:net') as typeof import('node:net')
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        const p = typeof addr === 'object' && addr ? addr.port : 0
        s.close(() => resolve(p))
      })
    })
    await expect(resolveCdpWebSocketUrl(port, 500)).rejects.toThrow(/CDP 超时/)
  })
})
