import type { Locale } from "../core/types.ts"
import { en } from "./en.ts"
import { ru } from "./ru.ts"
import type { MessageKey, Messages } from "./keys.ts"

export { MESSAGE_KEYS } from "./keys.ts"
export type { MessageKey, Messages } from "./keys.ts"
export { en } from "./en.ts"
export { ru } from "./ru.ts"

export const DICTIONARIES: Record<Locale, Messages> = { en, ru }

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""))
}

export function message(lang: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const dictionary = DICTIONARIES[lang] ?? en
  return interpolate(dictionary[key] ?? en[key] ?? key, vars)
}
