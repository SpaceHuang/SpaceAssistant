import { describe, expect, it } from 'vitest'
import { matchOauthClientPreset, type McpOAuthClientPreset } from './oauthClientPresets'

const FAKE_PRESET: McpOAuthClientPreset = {
  presetId: 'fake-github',
  displayName: 'GitHub (fake test preset)',
  serverOrigin: 'https://api.github.com',
  issuer: 'https://github.com',
  clientId: 'public-client-id',
  allowedScopes: ['repo', 'read:org'],
  redirectUriPolicy: 'loopback'
}

describe('matchOauthClientPreset', () => {
  it('matches exactly on origin and issuer', () => {
    expect(matchOauthClientPreset('https://api.github.com', 'https://github.com/', [FAKE_PRESET])?.presetId).toBe(
      'fake-github'
    )
  })

  it('does not match similar or subdomain origins', () => {
    expect(matchOauthClientPreset('https://github.com', 'https://github.com', [FAKE_PRESET])).toBeUndefined()
    expect(matchOauthClientPreset('https://sub.api.github.com', 'https://github.com', [FAKE_PRESET])).toBeUndefined()
  })

  it('does not match a different issuer', () => {
    expect(matchOauthClientPreset('https://api.github.com', 'https://other.example.com', [FAKE_PRESET])).toBeUndefined()
  })

  it('returns undefined when the preset directory is empty (GitHub 未核实)', () => {
    expect(matchOauthClientPreset('https://api.github.com', 'https://github.com')).toBeUndefined()
  })
})
