/** Stable, machine-readable tool-result truncation marker (always the last line of a result). */
export const MAX_RESULT = 12_000;

export const formatMarker = (tool: string, omitted: number | string, next: string): string =>
  `[[truncated tool=${tool} omitted=${omitted} next=${next.replace(/\s+/g, "_")}]]`;

const MARKER = /\[\[truncated tool=(\S+) omitted=(\d+\+?) next=(\S*)\]\]$/;

/** Parses the marker on the final line of a result; undefined when the result is not truncated. */
export const parseMarker = (result: string): { tool: string; omitted: string; next: string } | undefined => {
  const m = MARKER.exec(result.trimEnd().split("\n").pop() ?? "");
  return m ? { tool: m[1]!, omitted: m[2]!, next: m[3]! } : undefined;
};

/** Cuts text so that text plus marker never exceeds the cap. */
export const clipResult = (s: string, tool: string, hint: string): string => {
  if (s.length <= MAX_RESULT) return s;
  const probe = formatMarker(tool, s.length, hint);
  const keep = MAX_RESULT - probe.length - 1;
  return `${s.slice(0, keep)}\n${formatMarker(tool, s.length - keep, hint)}`;
};
