import { describe, expect, it } from 'vitest'
import { extractHttpUrl } from './feishuCliFlow'

describe('extractHttpUrl', () => {
  it('extracts feishu cli setup url from mixed text', () => {
    const text =
      '或打开以下链接完成配置：\n  https://open.feishu.cn/page/cli?user_code=LNCC-EJ9C&lpv=1.0.40\n正在获取...'
    expect(extractHttpUrl(text)).toBe(
      'https://open.feishu.cn/page/cli?user_code=LNCC-EJ9C&lpv=1.0.40'
    )
  })
})
