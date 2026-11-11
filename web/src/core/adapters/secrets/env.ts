import type { Ref } from "../../model/resource.ts";
import type { SecretResolver } from "../../ports/index.ts";

/** ADR-0015: `anthropic-api-key` → ANTHROPIC_API_KEY. */
export class EnvSecretResolver implements SecretResolver {
  private readonly env: Record<string, string | undefined>;
  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }
  resolve(ref: Ref | undefined): string | undefined {
    if (!ref) return undefined;
    const v = this.env[ref.name.toUpperCase().replace(/-/g, "_")];
    return v && v.length > 0 ? v : undefined;
  }
}
