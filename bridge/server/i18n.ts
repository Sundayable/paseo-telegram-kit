import { SETTINGS } from "./config.ts";

// Human-facing bridge text in the owner's language. Agent-facing prompts keep their Korean
// markers (the orchestrator system prompt documents them); only the owner's name changes there.

export type Language = "ko" | "en";

let language: Language = SETTINGS.language;
let ownerName = SETTINGS.ownerName;

/** The Korean text, or the English one when the bridge runs in English. */
export function t(ko: string, en: string): string {
  return language === "en" ? en : ko;
}

export function currentLanguage(): Language {
  return language;
}

/** Tests switch languages; production keeps the value from config.json. */
export function setLanguage(next: Language): void {
  language = next;
}

/** The person this bridge works for (`ownerName` in config.json). */
export function owner(): string {
  return ownerName;
}

/** Tests only. */
export function setOwner(name: string): void {
  ownerName = name;
}

/** The owner with the Korean honorific, for human-facing Korean text: "Mina님". */
export function ownerNim(): string {
  return `${ownerName}님`;
}

/**
 * Korean particle after a name: `josa("Jun", "이", "가")` → "이". Hangul uses the final consonant;
 * Latin names count a trailing vowel letter (a e i o u y) as open, anything else as closed.
 */
export function josa(word: string, closed: string, open: string): string {
  const last = word.trim().at(-1) ?? "";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? closed : open;
  return /[aeiouy]$/i.test(last) ? open : closed;
}

/** The owner's name with its subject/topic particle: "Mina가", "Jun이". */
export function ownerWith(closed: string, open: string): string {
  return `${ownerName}${josa(ownerName, closed, open)}`;
}
