import dns from 'dns/promises'
import http from 'http'
import type { AddressInfo } from 'net'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpEndpointValidationError, createSseTransport } from './sseTransport'

type HttpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void

const servers: Array<http.Server> = []
const receivedHeaders: Array<http.IncomingHttpHeaders> = []

function listen(handler: HttpHandler): Promise<{ server: http.Server; endpoint: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      receivedHeaders.push(req.headers)
      handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      const { port } = server.address() as AddressInfo
      resolve({ server, endpoint: `http://127.0.0.1:${port}/sse` })
    })
  })
}

function sendSseMessage(res: http.ServerResponse, body: unknown): void {
  res.write(`data: ${JSON.stringify(body)}\n\n`)
}

async function readJson(req: http.IncomingMessage): Promise<{ method?: string; id?: number }> {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  await new Promise<void>((resolve) => req.on('end', resolve))
  return JSON.parse(raw) as { method?: string; id?: number }
}

function startLegacyMcpSseServer(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.write('event: endpoint\ndata: /messages?sessionId=test-session\n\n')
}

afterAll(() => {
  for (const server of servers) server.close()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createSseTransport', () => {
  it('connects over legacy SSE, resolves a relative message endpoint, and injects auth headers', async () => {
    let sseResponse: http.ServerResponse | null = null
    const { server, endpoint } = await listen((req, res) => {
      if (req.method === 'GET') {
        startLegacyMcpSseServer(res)
        sseResponse = res
        return
      }
      void readJson(req).then((message) => {
        res.writeHead(202)
        res.end()
        if (message.method === 'notifications/initialized') return
        const stream = sseResponse
        if (!stream) return
        if (message.method === 'initialize') {
          sendSseMessage(stream, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'legacy-sse', version: '1.0.0' }
            }
          })
        } else if (message.method === 'tools/list') {
          sendSseMessage(stream, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [{ name: 'legacy_tool', description: '', inputSchema: { type: 'object' } }]
            }
          })
        }
      })
    })

    const diagnostics: string[] = []
    const transport = await createSseTransport({
      endpoint,
      authHeaders: { Authorization: 'Bearer legacy-secret-token' },
      onDiagnostic: diagnostics.push.bind(diagnostics)
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    const tools = await client.listTools()

    expect(tools.tools[0]?.name).toBe('legacy_tool')
    expect(client.getServerVersion()?.name).toBe('legacy-sse')
    expect(
      receivedHeaders.filter((headers) => headers.authorization === 'Bearer legacy-secret-token')
    ).toHaveLength(4)
    expect(diagnostics.join('\n')).not.toContain('legacy-secret-token')

    await client.close()
    server.close()
  })

  it('rejects GET redirects through the policy fetch', async () => {
    const { endpoint } = await listen((_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/redirected-sse' })
      res.end()
    })

    await expect(createSseTransport({ endpoint })).resolves.toBeDefined()
    const transport = await createSseTransport({ endpoint })
    await expect(transport.start()).rejects.toThrow(/重定向/)
  })

  it('rejects non-https public endpoints, private resolved endpoints, and failed DNS resolution', async () => {
    await expect(createSseTransport({ endpoint: 'http://example.com/sse' })).rejects.toThrow(
      McpEndpointValidationError
    )
    await expect(createSseTransport({ endpoint: 'https://192.168.1.10/sse' })).rejects.toThrow(
      McpEndpointValidationError
    )

    const lookupSpy = vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('DNS unavailable'))
    await expect(createSseTransport({ endpoint: 'https://example.com/sse' })).rejects.toThrow(
      /Endpoint 域名解析失败：DNS unavailable/
    )
    expect(lookupSpy).toHaveBeenCalled()
  })

  it('rejects controlled auth header names', async () => {
    await expect(
      createSseTransport({
        endpoint: 'http://127.0.0.1/sse',
        authHeaders: { Host: 'evil.example.com' }
      })
    ).rejects.toThrow(/受控请求头/)
  })
})
