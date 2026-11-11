import type { ModelProvider } from "../model/kinds.ts";
import { SYSTEM_NAMESPACE } from "../model/resource.ts";
import type { LLMClientFactory, Lookup, ModelResolver, ResolvedModel, ResourceReader, SecretResolver } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

/**
 * ADR-0014: explicit providerRef > default provider in the namespace > default in factory-system.
 * A provider is usable only if its secret resolves (or it needs none, e.g. a local Ollama).
 */
export class DefaultModelResolver implements ModelResolver {
  private readonly reader: ResourceReader;
  private readonly secrets: SecretResolver;
  private readonly factories: Lookup<LLMClientFactory>;
  constructor(reader: ResourceReader, secrets: SecretResolver, factories: Lookup<LLMClientFactory>) {
    this.reader = reader;
    this.secrets = secrets;
    this.factories = factories;
  }

  async resolve(input: { namespace: string; tier?: string; providerRef?: { name: string; namespace?: string } }): Promise<ResolvedModel | undefined> {
    const candidates: ModelProvider[] = [];
    if (input.providerRef) {
      const p = await resolveRef<ModelProvider>(this.reader, "ModelProvider", input.providerRef, input.namespace);
      if (p) candidates.push(p);
    } else {
      const own = input.namespace === SYSTEM_NAMESPACE ? [] : await this.reader.list<ModelProvider>("ModelProvider", { namespace: input.namespace });
      const sys = await this.reader.list<ModelProvider>("ModelProvider", { namespace: SYSTEM_NAMESPACE });
      const byDefault = (a: ModelProvider, b: ModelProvider) => Number(!!b.spec.default) - Number(!!a.spec.default);
      candidates.push(...own.sort(byDefault), ...sys.sort(byDefault));
    }
    for (const p of candidates) {
      const factory = this.factories.get(p.spec.type);
      if (!factory) continue;
      const key = this.secrets.resolve(p.spec.secretRef);
      if (p.spec.secretRef && !key) continue;
      const tier = input.tier ?? "reasoning";
      const model = p.spec.models[tier] ?? p.spec.models.default ?? Object.values(p.spec.models)[0];
      if (!model) continue;
      return { provider: p.metadata.name, providerType: p.spec.type, model, tier, client: factory.create(p, key) };
    }
    return undefined;
  }
}
