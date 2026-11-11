import { DEFAULT_NAMESPACE, SYSTEM_NAMESPACE, type Ref, type Resource } from "../model/resource.ts";
import { clone, nsOf } from "../model/meta.ts";
import type { Source, WorkItem } from "../model/kinds.ts";
import type { AdmissionContext, KindLookup, Mutator, Validator } from "../ports/index.ts";
import { REF_FIELDS, resolveRef, walkRefs } from "../refs/refs.ts";

export const LABEL_SOURCE = "factory.ai-dlc.io/source";

const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function namespaceDefaulter(kinds: KindLookup): Mutator {
  return {
    name: "namespace-defaulter",
    appliesTo: () => true,
    async mutate(obj) {
      if (obj.metadata.namespace) return obj;
      const o = clone(obj);
      o.metadata.namespace = kinds.byKind(o.kind)?.scope === "definition" ? SYSTEM_NAMESPACE : DEFAULT_NAMESPACE;
      return o;
    },
  };
}

/** WorkItems inherit workflow/repositories from their Source (squad defaults come in v0.4, ADR-0011). */
export function sourceDefaultsMutator(): Mutator {
  return {
    name: "source-defaults",
    appliesTo: (k) => k === "WorkItem",
    async mutate(obj, ctx: AdmissionContext) {
      const wi = clone(obj) as WorkItem;
      const source = await resolveRef<Source>(ctx.reader, "Source", wi.spec.sourceRef, nsOf(wi));
      const defaults = source?.spec.defaults;
      if (defaults?.workflowRef && !wi.spec.workflowRef) wi.spec.workflowRef = defaults.workflowRef;
      if (defaults?.repositoryRefs && !wi.spec.repositoryRefs?.length) wi.spec.repositoryRefs = defaults.repositoryRefs;
      wi.metadata.labels = { ...wi.metadata.labels, [LABEL_SOURCE]: wi.spec.sourceRef.name };
      return wi;
    },
  };
}

export function nameValidator(): Validator {
  return {
    name: "name",
    appliesTo: () => true,
    async validate(obj) {
      const n = obj.metadata.name;
      if (!n && obj.metadata.generateName) return [];
      return n && NAME_RE.test(n) && n.length <= 253 ? [] : [`metadata.name "${n}" must be lowercase kebab-case`];
    },
  };
}

/** Every *Ref in spec must resolve (same namespace, then factory-system). */
export function refValidator(): Validator {
  return {
    name: "refs",
    appliesTo: () => true,
    async validate(obj: Resource, ctx) {
      const problems: string[] = [];
      for (const { field, ref, path } of walkRefs(obj.spec, "spec")) {
        const r = ref as Ref | undefined;
        if (!r || typeof r !== "object" || typeof r.name !== "string") {
          problems.push(`${path}: malformed reference`);
          continue;
        }
        const kind = REF_FIELDS[field];
        if (!(await resolveRef(ctx.reader, kind, r, nsOf(obj)))) problems.push(`${path}: ${kind} "${r.name}" not found`);
      }
      return problems;
    },
  };
}

export function requiredFieldsValidator(kind: string, required: string[]): Validator {
  return {
    name: `required-${kind}`,
    appliesTo: (k) => k === kind,
    async validate(obj) {
      const spec = (obj.spec ?? {}) as Record<string, unknown>;
      return required.filter((f) => spec[f] === undefined || spec[f] === "").map((f) => `spec.${f} is required`);
    },
  };
}
