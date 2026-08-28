import { describe, expect, it } from 'vitest'
import {
  CONTROLLED_HEADERS,
  assertEndpointIpAllowed,
  isLoopbackHost,
  isPrivateOrReservedIp,
  validateMcpEndpoint,
  validateMcpHeaderName
} from './endpointPolicy'

describe('validateMcpEndpoint', () => {
  it('accepts a public https endpoint and normalizes it', () => {
    const result = validateMcpEndpoint('https://api.github.com/mcp')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.normalized).toBe('https://api.github.com/mcp')
  })

  it('accepts http only for loopback', () => {
    expect(validateMcpEndpoint('http://localhost:3000/mcp').ok).toBe(true)
    expect(validateMcpEndpoint('http://127.0.0.1:8080/mcp').ok).toBe(true)
    expect(validateMcpEndpoint('http://[::1]:8080/mcp').ok).toBe(true)
    expect(validateMcpEndpoint('http://example.com/mcp').ok).toBe(false)
  })

  it('rejects userinfo, query and fragment', () => {
    expect(validateMcpEndpoint('https://user:pass@example.com/mcp').ok).toBe(false)
    expect(validateMcpEndpoint('https://example.com/mcp?token=abc').ok).toBe(false)
    expect(validateMcpEndpoint('https://example.com/mcp#frag').ok).toBe(false)
  })

  it('rejects private and reserved addresses', () => {
    expect(validateMcpEndpoint('https://192.168.1.10/mcp').ok).toBe(false)
    expect(validateMcpEndpoint('https://10.0.0.5/mcp').ok).toBe(false)
    expect(validateMcpEndpoint('https://172.16.0.1/mcp').ok).toBe(false)
    expect(validateMcpEndpoint('https://169.254.169.254/mcp').ok).toBe(false)
    expect(validateMcpEndpoint('https://224.0.0.1/mcp').ok).toBe(false)
    expect(validateMcpEndpoint('https://[fc00::1]/mcp').ok).toBe(false)
    expect(validateMcpEndpoint('https://[fe80::1]/mcp').ok).toBe(false)
  })

  it('rejects non-http(s) schemes and malformed urls', () => {
    expect(validateMcpEndpoint('ftp://example.com/mcp').ok).toBe(false)
    expect(validateMcpEndpoint('not a url').ok).toBe(false)
  })
})

describe('header policy', () => {
  it('rejects controlled headers', () => {
    for (const header of CONTROLLED_HEADERS) {
      expect(validateMcpHeaderName(header)).toBe(false)
      expect(validateMcpHeaderName(header.toUpperCase())).toBe(false)
    }
  })

  it('accepts ordinary api key headers', () => {
    expect(validateMcpHeaderName('x-api-key')).toBe(true)
    expect(validateMcpHeaderName('X-Api-Key')).toBe(true)
    expect(validateMcpHeaderName('authorization')).toBe(true)
  })

  it('rejects malformed header names', () => {
    expect(validateMcpHeaderName('bad header')).toBe(false)
    expect(validateMcpHeaderName('')).toBe(false)
    expect(validateMcpHeaderName('a,b')).toBe(false)
  })
})

describe('IP policy helpers', () => {
  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('127.8.8.8')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
  })

  it('classifies private and reserved IPs', () => {
    expect(isPrivateOrReservedIp('10.1.2.3')).toBe(true)
    expect(isPrivateOrReservedIp('172.20.0.1')).toBe(true)
    expect(isPrivateOrReservedIp('192.168.0.1')).toBe(true)
    expect(isPrivateOrReservedIp('169.254.1.1')).toBe(true)
    expect(isPrivateOrReservedIp('100.64.0.1')).toBe(true)
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false)
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false)
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true)
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true)
    expect(isPrivateOrReservedIp('ff02::1')).toBe(true)
    expect(isPrivateOrReservedIp('2606:4700::1111')).toBe(false)
  })

  it('assertEndpointIpAllowed accepts public and loopback, rejects private', () => {
    expect(assertEndpointIpAllowed('8.8.8.8')).toBe(true)
    expect(assertEndpointIpAllowed('127.0.0.1')).toBe(true)
    expect(assertEndpointIpAllowed('192.168.0.1')).toBe(false)
    expect(assertEndpointIpAllowed('169.254.169.254')).toBe(false)
  })
})
