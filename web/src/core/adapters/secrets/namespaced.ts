import type { Ref } from "../../model/resource.ts";
import type { NamespacedSecretReader, SecretResolver } from "../../ports/index.ts";

/** ADR-0071: serves secretRefs from an in-memory copy of exactly one namespace; refs naming another namespace are refused. */
export class NamespacedSecretResolver implements SecretResolver {
  private cache: Record<string, Record<string, string>> = {};
  private readonly reader: NamespacedSecretReader;
  readonly namespace: string;
  constructor(reader: NamespacedSecretReader, namespace: string) {
    this.reader = reader;
    this.namespace = namespace;
  }

  async refresh(): Promise<void> {
    this.cache = await this.reader.readSecrets(this.namespace);
  }

  resolve(ref: Ref | undefined): string | undefined {
    if (!ref) return undefined;
    const ns = (ref as Ref & { namespace?: string }).namespace;
    if (ns !== undefined && ns !== this.namespace) return undefined;
    const data = this.cache[ref.name];
    if (!data) return undefined;
    const v = data.value ?? (Object.keys(data).length === 1 ? Object.values(data)[0] : undefined);
    return v && v.length > 0 ? v : undefined;
  }
}
