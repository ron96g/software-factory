import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** `local.path` in definitions: absolute, `~/…` (the user's home, keeps usernames out of Git), or relative to the factory root. */
export function resolveLocalPath(root: string, p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(root, p);
}
