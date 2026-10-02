import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildAgentContinuationProbeArgs } = require('../../scripts/agentContinuationProbeArgs.cjs') as {
  buildAgentContinuationProbeArgs(profilePath: string, probeEntry: string): string[]
}

describe('isolated Agent continuation Electron probe arguments', () => {
  it('binds the user-data path to its switch so Electron cannot treat it as the app path', () => {
    expect(buildAgentContinuationProbeArgs('/tmp/isolated-profile', '/repo/scripts/probe.cjs')).toEqual([
      '--user-data-dir=/tmp/isolated-profile',
      '/repo/scripts/probe.cjs'
    ])
  })
})
