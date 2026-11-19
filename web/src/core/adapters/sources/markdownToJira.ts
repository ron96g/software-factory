type AdfNode = { type: string; text?: string; attrs?: Record<string, unknown>; content?: AdfNode[]; marks?: { type: string; attrs?: Record<string, unknown> }[] };

/** Inline Markdown (code, bold, italic, links) → ADF text nodes. */
function inlineAdf(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "text", text: m[1], marks: [{ type: "code" }] });
    else if (m[2] !== undefined) out.push({ type: "text", text: m[2], marks: [{ type: "strong" }] });
    else if (m[3] !== undefined) out.push({ type: "text", text: m[3], marks: [{ type: "em" }] });
    else out.push({ type: "text", text: m[4], marks: [{ type: "link", attrs: { href: m[5] } }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out.length ? out : [{ type: "text", text }];
}

export function markdownToAdf(md: string): { type: "doc"; version: 1; content: AdfNode[] } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: AdfNode[] } | undefined;
  const flushPara = () => { if (para.length) content.push({ type: "paragraph", content: inlineAdf(para.join("\n")) }); para = []; };
  const flushList = () => { if (list) content.push({ type: list.ordered ? "orderedList" : "bulletList", content: list.items }); list = undefined; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*(\w*)/.exec(line);
    if (fence) {
      flushPara(); flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      content.push({ type: "codeBlock", ...(fence[1] ? { attrs: { language: fence[1] } } : {}), content: code.length ? [{ type: "text", text: code.join("\n") }] : [] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (heading) { flushPara(); flushList(); content.push({ type: "heading", attrs: { level: heading[1].length }, content: inlineAdf(heading[2]) }); }
    else if (item) {
      flushPara();
      const ordered = item[2] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push({ type: "listItem", content: [{ type: "paragraph", content: inlineAdf(item[3]) }] });
    } else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return { type: "doc", version: 1, content: content.length ? content : [{ type: "paragraph", content: [] }] };
}

/** Markdown → Jira wiki markup (Data Center / Server). */
export function markdownToWiki(md: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const fence = /^```\s*(\w*)/.exec(line);
    if (fence) { out.push(inCode ? "{code}" : fence[1] ? `{code:${fence[1]}}` : "{code}"); inCode = !inCode; continue; }
    if (inCode) { out.push(line); continue; }
    const inline = (s: string) => s
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "[$1|$2]")
      .replace(/\*\*([^*]+)\*\*/g, "\u0001$1\u0001")
      .replace(/(?<![*\w])\*([^*\s][^*]*)\*(?!\w)/g, "_$1_")
      .replace(/\u0001/g, "*")
      .replace(/`([^`]+)`/g, "{{$1}}");
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (heading) out.push(`h${heading[1].length}. ${inline(heading[2])}`);
    else if (item) out.push(`${item[2] !== undefined ? "#" : "*"} ${inline(item[3])}`);
    else out.push(inline(line));
  }
  if (inCode) out.push("{code}");
  return out.join("\n");
}
