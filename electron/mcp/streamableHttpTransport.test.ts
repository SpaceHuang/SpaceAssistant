import http from 'http'
import type { AddressInfo } from 'net'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpEndpointValidationError, createStreamableHttpTransport } from './streamableHttpTransport'

const servers: Array<http.Server> = []
const receivedHeaders: Array<http.IncomingHttpHeaders> = []

function startMcpServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      receivedHeaders.push(req.headers)
      handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      const { port } = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}/mcp`)
    })
  })
}

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

afterAll(() => {
  for (const server of servers) {
    server.close()
  }
})

describe('streamableHttpTransport', () => {
  it('connects, initializes and lists tools over Streamable HTTP with auth header', async () => {
    const endpoint = await startMcpServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        const message = JSON.parse(raw) as { method?: string; id?: number }
        if (message.method === 'initialize') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'http-server', version: '1.0.0' }
            }
          })
        } else if (message.method === 'tools/list') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [{ name: 'http_tool', description: 'http tool', inputSchema: { type: 'object' } }]
            }
          })
        } else if (message.method === 'notifications/initialized') {
          sendJson(res, { jsonrpc: '2.0' })
        } else {
          sendJson(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
        }
      })
    })

    const transport = await createStreamableHttpTransport({
      endpoint,
      authHeaders: { Authorization: 'Bearer secret-token' }
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools[0]!.name).toBe('http_tool')
    const serverVersion = client.getServerVersion()
    expect(serverVersion?.name).toBe('http-server')
    await client.close()

    // 每个请求都带认证头
    expect(receivedHeaders.some((h) => h.authorization === 'Bearer secret-token')).toBe(true)
  })

  it('rejects cross-origin redirects instead of following them', async () => {
    const endpoint = await startMcpServer((_req, res) => {
      res.writeHead(302, { Location: 'http://evil.example.com/mcp' })
      res.end()
    })

    const transport = await createStreamableHttpTransport({ endpoint })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await expect(client.connect(transport)).rejects.toThrow(/重定向/)
  })

  it('rejects endpoints resolving to private addresses at create time', async () => {
    await expect(
      createStreamableHttpTransport({ endpoint: 'https://192.168.1.10/mcp' })
    ).rejects.toThrow(McpEndpointValidationError)
  })

  it('rejects controlled headers', async () => {
    await expect(
      createStreamableHttpTransport({ endpoint: 'https://example.com/mcp', authHeaders: { Host: 'evil' } })
    ).rejects.toThrow(/受控请求头/)
  })
})
