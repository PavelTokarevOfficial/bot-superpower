export function extractMentionedText(text: string, botUsername: string): string | null {
  const mentionPattern = new RegExp(`@${escapeRegExp(botUsername)}\\b`, "iu");
  if (!mentionPattern.test(text)) {
    return null;
  }

  return text.replace(mentionPattern, "").trim();
}

export function textLength(text: string): number {
  return Array.from(text).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
