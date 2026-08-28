import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  buildStdioEnvironment,
  createStdioTransport,
  validateStdioCommand
} from './stdioTransport'

const WINDOWS_PATH = 'C:\\nodejs;C:\\tools;C:\\Windows\\System32'
const WINDOWS_BASE_ENV = {
  PATH: WINDOWS_PATH,
  Path: 'C:\\duplicate',
  path: 'C:\\duplicate-2',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  HOME: 'C:\\Users\\test'
}

describe('validateStdioCommand', () => {
  it('accepts a plain executable on Windows', () => {
    const result = validateStdioCommand({ command: 'node', args: ['server.js'] }, { platform: 'win32' })
    expect(result.ok).toBe(true)
  })

  it('rejects npx on Windows with readable guidance (B1)', () => {
    const result = validateStdioCommand(
      { command: 'npx', args: ['-y', 'pkg'] },
      {
        platform: 'win32',
        baseEnv: { PATH: 'C:\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        pathLookup: () => 'C:\\nodejs\\npx.cmd'
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/npx/)
      expect(result.error).toMatch(/node/)
      expect(result.error).toMatch(/python|docker/)
    }
  })

  it('rejects explicit .cmd and .bat paths on Windows', () => {
    const cmd = validateStdioCommand(
      { command: 'C:\\tools\\server.cmd', args: [] },
      { platform: 'win32' }
    )
    expect(cmd.ok).toBe(false)
    const bat = validateStdioCommand(
      { command: 'C:\\tools\\server.bat', args: [] },
      { platform: 'win32' }
    )
    expect(bat.ok).toBe(false)
  })

  it('allows npx on non-Windows platforms', () => {
    const result = validateStdioCommand({ command: 'npx', args: ['-y', 'pkg'] }, { platform: 'linux' })
    expect(result.ok).toBe(true)
  })

  it('rejects sensitive values in args on all platforms', () => {
    const win = validateStdioCommand(
      { command: 'node', args: ['server.js', '--token', 'abc'] },
      { platform: 'win32' }
    )
    expect(win.ok).toBe(false)
    const posix = validateStdioCommand(
      { command: 'node', args: ['server.js', '--api-key=sk-test'] },
      { platform: 'darwin' }
    )
    expect(posix.ok).toBe(false)
  })

  it('rejects a PATH-resolved .cmd shim (B1)', () => {
    const result = validateStdioCommand(
      { command: 'tool', args: [] },
      {
        platform: 'win32',
        baseEnv: {
          PATH: WINDOWS_PATH,
          PATHEXT: '.COM;.EXE;.BAT;.CMD'
        },
        pathLookup: () => 'C:\\tools\\tool.cmd'
      }
    )
    expect(result.ok).toBe(false)
  })

  it('accepts a PATH-resolved .exe', () => {
    const result = validateStdioCommand(
      { command: 'tool', args: [] },
      {
        platform: 'win32',
        baseEnv: { PATH: WINDOWS_PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        pathLookup: () => 'C:\\tools\\tool.exe'
      }
    )
    expect(result.ok).toBe(true)
  })

  it('rejects an empty command', () => {
    const result = validateStdioCommand({ command: '  ', args: [] }, { platform: 'win32' })
    expect(result.ok).toBe(false)
  })
})

describe('buildStdioEnvironment', () => {
  it('always includes PATH', () => {
    const env = buildStdioEnvironment({}, { platform: 'win32', baseEnv: WINDOWS_BASE_ENV })
    expect(env.PATH).toBe(WINDOWS_PATH)
  })

  it('includes Windows-required vars with case-insensitive dedupe', () => {
    const env = buildStdioEnvironment({}, { platform: 'win32', baseEnv: WINDOWS_BASE_ENV })
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD')
    // PATH/Path/path 大小写去重：最终只保留一个 PATH 键，值为第一个命中的项
    expect(env.PATH).toBe(WINDOWS_PATH)
    expect(env.Path).toBeUndefined()
    expect(env.path).toBeUndefined()
  })

  it('does not leak unrelated host env vars by default', () => {
    const env = buildStdioEnvironment({}, { platform: 'win32', baseEnv: WINDOWS_BASE_ENV })
    expect(env.HOME).toBeUndefined()
  })

  it('merges user env overrides on top', () => {
    const env = buildStdioEnvironment(
      { MCP_TEST_TOKEN: 'value', PATH: 'C:\\custom' },
      { platform: 'win32', baseEnv: WINDOWS_BASE_ENV }
    )
    expect(env.MCP_TEST_TOKEN).toBe('value')
    expect(env.PATH).toBe('C:\\custom')
  })

  it('dedupes case-insensitively on posix for PATH only', () => {
    const env = buildStdioEnvironment({}, {
      platform: 'linux',
      baseEnv: { PATH: '/usr/bin:/bin', Home: '/root' }
    })
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.Home).toBeUndefined()
  })
})

describe('createStdioTransport integration', () => {
  let tempDir: string

  afterAll(() => {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('connects to a real node MCP server, discovers tools, passes env, masks stderr', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mcp-stdio-'))
    const scriptPath = path.join(tempDir, 'server.js')
    fs.writeFileSync(
      scriptPath,
      `
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
process.stderr.write('startup warn sk-ant-api03-abcdef\\n')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: process.env.MCP_TEST_ENV || 'no-env', version: '1.0.0' }
    }})
  } else if (req.method === 'notifications/initialized') {
    // no reply
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [
      { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: {} } }
    ]}})
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
  }
})
`,
      'utf8'
    )

    const stderrLines: string[] = []
    const transport = createStdioTransport(
      { command: process.execPath, args: [scriptPath], env: { MCP_TEST_ENV: 'env-passed' } },
      { onStderr: (line) => stderrLines.push(line) }
    )
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(transport)

    const tools = await client.listTools()
    expect(tools.tools[0]!.name).toBe('echo')
    const version = client.getServerVersion()
    expect(version?.name).toBe('env-passed')

    await client.close()

    // stderr 经过脱敏（sanitizeForLog 掩码 sk-ant-*）
    expect(stderrLines.some((l) => l.includes('sk-ant-api03-abcdef'))).toBe(false)
    expect(stderrLines.some((l) => l.includes('startup warn'))).toBe(true)
  })
})
