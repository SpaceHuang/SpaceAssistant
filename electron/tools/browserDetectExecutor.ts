import { stagehandService } from '../browser/stagehandService'
import type { ToolExecutor, ToolExecutorResult } from './types'

export const browserDetectExecutor: ToolExecutor = {
  name: 'browser_detect',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const force = input.force === true

    if (ctx.getBrowserDetectContext) {
      stagehandService.configureDetectContext(ctx.getBrowserDetectContext())
    }

    ctx.sendProgress('detecting', '正在检测浏览器依赖…')

    try {
      const result = await stagehandService.detectDependencies(force)
      return { success: true, data: result, duration: Date.now() - started }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { success: false, error: message, duration: Date.now() - started }
    }
  }
}
