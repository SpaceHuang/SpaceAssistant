import { renderSkillFragments, type SkillFragment } from './promptAssembly'

export type SerializedPromptMessage = { role: 'user' | 'assistant'; content: unknown }

export function serializePromptAssembly(args: { history: readonly SerializedPromptMessage[]; skillFragments?: readonly SkillFragment[] }): SerializedPromptMessage[] {
  const messages = args.history.slice()
  if (!args.skillFragments?.length) return messages
  const fragments = renderSkillFragments({ sections: [], contexts: [], tools: [], variables: {}, skillFragments: [...args.skillFragments] })
  return [...messages, ...fragments.map((content) => ({ role: 'user' as const, content }))]
}
