import type { AppLocale } from './locale'

const ZH_CN_HINT = `<ui_locale_preference>
The user's application interface language is Simplified Chinese (zh-CN).
You MUST write all user-visible assistant replies in Simplified Chinese.
You MUST write all thinking/reasoning blocks in Simplified Chinese as well — even when the user's message is in another language.
The language of thinking must always match the UI language; do not default to English (or any other language) for internal reasoning.
Keep code snippets, file paths, command lines, and proper nouns in their original form; do not translate them.
If the user explicitly asks you to use another language for the visible reply, follow that instruction for the reply only; thinking still uses Simplified Chinese.
</ui_locale_preference>`

const EN_US_HINT = `<ui_locale_preference>
The user's application interface language is English (en-US).
You MUST write all user-visible assistant replies in English.
You MUST write all thinking/reasoning blocks in English as well — even when the user's message is in another language.
The language of thinking must always match the UI language; do not switch to Chinese or other languages for internal reasoning.
Keep code snippets, file paths, command lines, and proper nouns in their original form; do not translate them.
If the user explicitly asks you to use another language for the visible reply, follow that instruction for the reply only; thinking still uses English.
</ui_locale_preference>`

/** 生成 <ui_locale_preference> 段落 */
export function buildUiLocaleSystemHint(locale: AppLocale): string {
  return locale === 'en-US' ? EN_US_HINT : ZH_CN_HINT
}

/** 追加到已有 system；空 system 时仅返回引导段 */
export function appendUiLocaleSystemHint(
  system: string | undefined,
  locale: AppLocale
): string | undefined {
  const hint = buildUiLocaleSystemHint(locale)
  if (!system || system.trim().length === 0) return hint
  return `${system}\n\n${hint}`
}
