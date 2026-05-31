import type { BrowserDependencyToolError } from '../../src/shared/browserTypes'

export { resolveDependencyRecoverySkill, CHROMIUM_RECOVERY_CODES, BROWSER_SETUP_RECOVERY_SKILL } from '../../src/shared/browserDependencyRecovery'

export function formatDependencyRecoveryToolContent(err: BrowserDependencyToolError): string {
  return JSON.stringify({
    dependencySetupRequired: true,
    errorCode: err.errorCode,
    message:
      '检测到 Chromium 尚未就绪。已为你加载「网络访问修复」引导；我将代为运行安装命令（需你在确认卡片中批准）。完成后告诉我，我会重新检测。',
    installCommand: err.installCommand,
    recommendedCwdHint: '应用安装目录'
  })
}
