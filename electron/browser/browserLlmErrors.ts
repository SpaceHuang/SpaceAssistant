function collectLlmErrorText(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur != null; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      const body = (cur as Error & { responseBody?: unknown }).responseBody
      if (typeof body === 'string' && body.trim()) parts.push(body)
      cur = cur.cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join('\n')
}

export function classifyBrowserLlmError(err: unknown): string {
  const msg = collectLlmErrorText(err) || (err instanceof Error ? err.message : String(err))
  const lower = msg.toLowerCase()

  if (/thinking mode does not support.*tool_choice|thinking mode does not support this tool/i.test(lower)) {
    return (
      '浏览器所用 DeepSeek 模型处于思考（Thinking）模式，无法提取或分析页面内容。' +
      '请完全退出并重启应用后重试；若仍失败，请在设置 → 浏览器中更换 Stagehand 模型（例如 deepseek-v4-flash）。'
    )
  }

  if (
    /401|403/.test(msg) ||
    /invalid api key/i.test(msg) ||
    /authentication/i.test(lower) ||
    /unauthorized/i.test(lower)
  ) {
    return 'Stagehand 模型凭证无效，请在设置中检查 API Key 或切换模型'
  }

  if (/429|quota|billing|rate limit/i.test(lower)) {
    return 'Stagehand 模型调用额度不足，请检查账户配额或切换模型'
  }

  if (
    /econnrefused|enotfound|timeout|502|503|504|5xx|bad gateway|service unavailable/i.test(
      lower
    )
  ) {
    return 'Stagehand 模型服务暂时不可达，请检查网络或稍后重试'
  }

  return '浏览器操作失败'
}

export function isPlaywrightNavigationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /net::|NS_ERROR|ERR_|timeout/i.test(msg)
}
