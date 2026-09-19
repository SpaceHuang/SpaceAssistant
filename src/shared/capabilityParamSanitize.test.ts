import { describe, expect, it } from 'vitest'
import {
  sanitizeCapabilityParamsForDisplay,
  sanitizeUrlCredentials,
  CREDENTIAL_KEY_PATTERN
} from './capabilityParamSanitize'

describe('capabilityParamSanitize（v2 评审建议 5 专属单测）', () => {
  it('凭据键布尔化：accessToken/headerValue/oauthClientId 等', () => {
    const out = sanitizeCapabilityParamsForDisplay({
      accessToken: 'ghp_secret',
      headerValue: 'Bearer xyz',
      refreshToken: 'rt_1',
      clientSecret: 'cs_1'
    }) as Record<string, unknown>
    expect(out.accessToken).toBe(true)
    expect(out.headerValue).toBe(true)
    expect(out.refreshToken).toBe(true)
    expect(out.clientSecret).toBe(true)
  })

  it('headerName 放行（v2 评审建议 5）：保留「用哪个 header 鉴权」的可辨识信息', () => {
    const out = sanitizeCapabilityParamsForDisplay({ headerName: 'X-Custom-Auth' })
    expect(out.headerName).toBe('X-Custom-Auth')
    expect(CREDENTIAL_KEY_PATTERN.test('headerName')).toBe(false)
  })

  it('env 键值表大小写不敏感（ENV/Env 同样布尔化）', () => {
    // 顶层调用不传 key（key 是递归内部参数，与 record.input 的实际调用形态一致）
    for (const key of ['env', 'ENV', 'Env']) {
      const out = sanitizeCapabilityParamsForDisplay({ [key]: { API_TOKEN: 'tok', DEBUG: '1' } }) as Record<string, unknown>
      const table = out[key] as Record<string, unknown>
      expect(table).toEqual({ API_TOKEN: true, DEBUG: true })
    }
  })

  it('嵌套结构与数组递归；清单内键布尔化、清单外普通键原样（锚定匹配口径）', () => {
    const out = sanitizeCapabilityParamsForDisplay({
      name: 'scys',
      endpoint: 'https://mcp.scys.com/mcp',
      nested: { token: 'v' },
      list: [{ secret: 's' }]
    }) as Record<string, unknown>
    expect(out.name).toBe('scys')
    expect(out.endpoint).toBe('https://mcp.scys.com/mcp')
    expect((out.nested as Record<string, unknown>).token).toBe(true)
    expect((out.list as Array<Record<string, unknown>>)[0]!.secret).toBe(true)
  })
})

describe('sanitizeUrlCredentials（R1：URL 内嵌凭据打码，userinfo + 凭据 query）', () => {
  it('userinfo 段打码且保留 URL 形态', () => {
    expect(sanitizeUrlCredentials('https://user:pass@mcp.example.com/mcp')).toBe(
      'https://***:***@mcp.example.com/mcp'
    )
    expect(sanitizeUrlCredentials('https://user@mcp.example.com/mcp')).toBe(
      'https://***:***@mcp.example.com/mcp'
    )
    expect(sanitizeUrlCredentials('https://mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp')
  })

  it('凭据类 query 参数值打码（大小写不敏感）', () => {
    expect(sanitizeUrlCredentials('https://mcp.example.com/mcp?api_key=sk-secret&page=1')).toBe(
      'https://mcp.example.com/mcp?api_key=***&page=1'
    )
    expect(sanitizeUrlCredentials('https://mcp.example.com/mcp?Token=abc&sig=xyz')).toBe(
      'https://mcp.example.com/mcp?Token=***&sig=***'
    )
  })

  it('非法 URL 保守处理（query 凭据仍打码）', () => {
    expect(sanitizeUrlCredentials('not a url?token=abc')).toBe('not a url?token=***')
  })

  it('sanitizeCapabilityParamsForDisplay 对 endpoint/url 键应用 URL 打码（含 userinfo）', () => {
    const out = sanitizeCapabilityParamsForDisplay({
      endpoint: 'https://user:pass@mcp.example.com/mcp?api_key=sk-1'
    }, 'endpoint')
    const v = out as Record<string, string>
    expect(JSON.stringify(v)).not.toContain('user:pass')
    expect(JSON.stringify(v)).not.toContain('sk-1')
    expect(v.endpoint).toContain('***:***@mcp.example.com/mcp?api_key=***')
  })
})
