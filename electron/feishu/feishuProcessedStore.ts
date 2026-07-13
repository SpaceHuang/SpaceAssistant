import { ImProcessedStore } from '../remote/imProcessedStore'
import { logFeishuCliEvent } from './feishuCliLogger'

export class FeishuProcessedStore extends ImProcessedStore {
  constructor(userDataDir: string) {
    super({
      channel: 'feishu',
      userDataDir,
      logEvent: logFeishuCliEvent
    })
  }
}
