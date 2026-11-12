/** ADR-0030: fence the refine responder uses for a suggested entry; the UI offers "Apply this draft" for it. */
export const DRAFT_FENCE = "knowledge-draft";

/** Four backticks, so entries may contain ``` code blocks. */
/** The last suggested draft in an assistant message: first line `# <title>`, then the Markdown content. */
export function parseDraft(text: string): { title: string; content: string } | null {
  const blocks = [...text.matchAll(new RegExp("````" + DRAFT_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n````", "g"))];
  const body = blocks.at(-1)?.[1]?.trim();
  if (!body) return null;
  const [first, ...rest] = body.split("\n");
  const title = first.replace(/^#\s*/, "").trim();
  const content = rest.join("\n").trim();
  return title && content ? { title, content } : null;
}
