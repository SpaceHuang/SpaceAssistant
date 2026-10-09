import type { RemoteAuthChannel } from './remoteAuthorizationRegistry'

export function createRemoteAuthorizationRevocationCoordinator<TConfig>(input: {
  writeConfig: (request: { channels: readonly RemoteAuthChannel[]; reason: string; config?: unknown }) => TConfig
  advanceEpoch: (channel: RemoteAuthChannel, reason: string) => number
  cascade: (channel: RemoteAuthChannel, epoch: number, reason: string) => unknown
  completeRevocation: (channel: RemoteAuthChannel, epoch: number) => boolean
  blockChannels: (channels: readonly RemoteAuthChannel[], reason: string) => void
  markChannelsReady: (channels: readonly RemoteAuthChannel[]) => void
}) {
  return {
    commit(request: { channels: readonly RemoteAuthChannel[]; reason: string; config?: unknown }): { success: true; config: TConfig; channels: RemoteAuthChannel[] } {
      const channels = [...new Set(request.channels)]
      if (!request.reason.trim() || channels.length === 0) throw new TypeError('REMOTE_AUTHORIZATION_REVOCATION_REQUEST_INVALID')
      input.blockChannels(channels, request.reason)
      try {
        const config = input.writeConfig(request)
        for (const channel of channels) {
          const epoch = input.advanceEpoch(channel, request.reason)
          input.cascade(channel, epoch, request.reason)
          if (!input.completeRevocation(channel, epoch)) throw new Error(`REMOTE_AUTHORIZATION_REVOCATION_COMMIT_FAILED:${channel}:${epoch}`)
        }
        input.markChannelsReady(channels)
        return { success: true, config, channels }
      } catch (error) {
        // Keep dispatch fenced after config, epoch, or cascade failure; caller receives no success result.
        throw error
      }
    }
  }
}
