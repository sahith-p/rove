// Reply text cleanup: the agent texts plain sentences, so markdown and any leaked internal markup are removed.

/** Drops stray internal markup the model occasionally leaks ("antml:reasoning_effort: …", "<thinking>…</thinking>"). */
export function stripLeakedMarkup(s: string): string {
  return s
    .replace(/<(thinking|reasoning|system|function_calls|invoke|parameter)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(antml:[a-z_]+|thinking|reasoning|system|function_calls|invoke|parameter)[^>]*>/gi, "")
    .replace(/\bantml:[a-z_]+\s*[:=]?\s*(?:(?:low|medium|high|xhigh|max|true|false|\d+)\b[:,]?\s*)?/gi, "")
    .trim();
}

export function plainText(s: string): string {
  return stripLeakedMarkup(s)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`+/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
