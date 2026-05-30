import type { BrowserDependencyFailureCode, BrowserDependencyToolError } from '../../src/shared/browserTypes'
import { isChromiumRecoveryFailure } from './browserDependencyDetect'

const RECOVERY_SKILL = 'browser-setup-guide'

export function resolveDependencyRecoverySkill(errorCode: string): string | null {
  if (isChromiumRecoveryFailure(errorCode as BrowserDependencyFailureCode)) {
    return RECOVERY_SKILL
  }
  return null
}

export function formatDependencyRecoveryToolContent(err: BrowserDependencyToolError): string {
  return JSON.stringify({
    dependencySetupRequired: true,
    errorCode: err.errorCode,
    message:
      '检测到 Chromium 浏览器尚未安装或不可用。聊天界面已展示安装引导卡片，请按步骤在终端完成安装后点击「重新检测」，然后重新发送你的请求。',
    installCommand: err.installCommand,
    recommendedCwdHint: err.detectResult.installContext === 'packaged' ? '应用安装目录' : '源码根目录'
  })
}
