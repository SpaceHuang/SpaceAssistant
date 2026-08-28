import { describe, expect, it } from 'vitest'
import {
  clearAllMcpSessionTrust,
  clearMcpSessionTrustForSession,
  isMcpSessionTrusted,
  rememberMcpSessionTrust
} from './mcpSessionTrust'

describe('mcpSessionTrust', () => {
  it('remembers trust scoped to session + server + tool', () => {
    rememberMcpSessionTrust('session-1', 'server-1', 'create_issue')
    expect(isMcpSessionTrusted('session-1', 'server-1', 'create_issue')).toBe(true)
    expect(isMcpSessionTrusted('session-1', 'server-1', 'other_tool')).toBe(false)
    expect(isMcpSessionTrusted('session-1', 'server-2', 'create_issue')).toBe(false)
    expect(isMcpSessionTrusted('session-2', 'server-1', 'create_issue')).toBe(false)
  })

  it('clears trust per session', () => {
    rememberMcpSessionTrust('session-1', 'server-1', 'create_issue')
    rememberMcpSessionTrust('session-2', 'server-1', 'create_issue')
    clearMcpSessionTrustForSession('session-1')
    expect(isMcpSessionTrusted('session-1', 'server-1', 'create_issue')).toBe(false)
    expect(isMcpSessionTrusted('session-2', 'server-1', 'create_issue')).toBe(true)
  })

  it('clears all trust', () => {
    rememberMcpSessionTrust('session-1', 'server-1', 'create_issue')
    clearAllMcpSessionTrust()
    expect(isMcpSessionTrusted('session-1', 'server-1', 'create_issue')).toBe(false)
  })
})
