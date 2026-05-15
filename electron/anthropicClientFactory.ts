import Anthropic from '@anthropic-ai/sdk'

export function createAnthropicClient(apiKey: string, baseURL?: string): Anthropic {
  return baseURL ? new Anthropic({ apiKey, baseURL }) : new Anthropic({ apiKey })
}
