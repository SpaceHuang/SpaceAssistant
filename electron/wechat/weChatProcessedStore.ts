import { ImProcessedStore } from '../remote/imProcessedStore'
import { logWeChatCliEvent } from './weChatCliLogger'

export class WeChatProcessedStore extends ImProcessedStore {
  constructor(userDataDir: string) {
    super({
      channel: 'wechat',
      userDataDir,
      logEvent: logWeChatCliEvent
    })
  }
}
