import ts from "typescript-api";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { CRD_GROUP, CRD_VERSION, DEFINITION_CRDS } from "./cr-mapper.ts";

/**
 * deploy/kubernetes/crds.yaml is generated from the TypeScript model (`<Kind>Spec` in model/kinds.ts) with the
 * compiler API, so a field added to the code changes the CRD and the drift test fails until it is regenerated.
 * Constraints and CEL rules live as JSDoc tags next to the fields:
 * `@minimum`, `@maxLength`, `@pattern`, `@minItems`, `@maxItems`, `@minProperties`, `@maxProperties`,
 * `@validation rule="…" message="…"` (on an interface or property → x-kubernetes-validations),
 * `@preserveUnknownFields <reason>` (free-form object), `@preserveUnknownValues <reason>` (map of free-form values).
 * Untagged `unknown`/`any`/mixed unions fail generation, so free-form fields are always deliberate.
 */
type Schema = Record<string, unknown>;

const MODEL = fileURLToPath(new URL("../model/kinds.ts", import.meta.url));
const NUMERIC_TAGS = ["minimum", "maximum", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"];

interface Tag { name: string; text: string }

/** Reads the JSDoc block right before a declaration; parsed from source text so it works in any JSDoc parsing mode. */
function tagsOf(symbol: ts.Symbol | undefined): Tag[] {
  const decl = symbol?.declarations?.[0];
  if (!decl) return [];
  const text = decl.getSourceFile().getFullText();
  const trivia = text.slice(decl.getFullStart(), decl.getStart());
  const doc = trivia.match(/\/\*\*[\s\S]*?\*\//g)?.pop();
  if (!doc) return [];
  const body = doc.slice(3, -2).split("\n").map((l) => l.replace(/^\s*\*?\s?/, "")).join("\n");
  return [...body.matchAll(/@(\w+)([^@]*)/g)].map((m) => ({ name: m[1], text: m[2].replace(/\s+/g, " ").trim() }));
}

function validations(tags: Tag[], name: string): { rule: string; message: string }[] {
  return tags.filter((t) => t.name === name).map((t) => {
    const m = /^rule="(.*)"\s+message="(.*)"$/s.exec(t.text);
    if (!m) throw new Error(`malformed @${name}: ${t.text}`);
    return { rule: m[1], message: m[2] };
  });
}

function applyTags(schema: Schema, tags: Tag[]): Schema {
  const out = { ...schema };
  for (const t of tags) {
    if (NUMERIC_TAGS.includes(t.name)) out[t.name] = Number(t.text);
    if (t.name === "pattern") out.pattern = t.text;
  }
  const rules = validations(tags, "validation");
  if (rules.length) out["x-kubernetes-validations"] = [...((out["x-kubernetes-validations"] as unknown[]) ?? []), ...rules];
  return out;
}

class Walker {
  private readonly checker: ts.TypeChecker;
  constructor(checker: ts.TypeChecker) {
    this.checker = checker;
  }

  property(symbol: ts.Symbol, path: string): Schema | undefined {
    const tags = tagsOf(symbol);
    const type = this.checker.getNonNullableType(this.checker.getTypeOfSymbol(symbol));
    if (type.flags & ts.TypeFlags.Never) return undefined;
    const values = tags.find((t) => t.name === "preserveUnknownValues");
    if (values) {
      if (!values.text) throw new Error(`${path}: @preserveUnknownValues needs a reason`);
      const value: Schema = { "x-kubernetes-preserve-unknown-fields": true };
      return applyTags({ type: "object", additionalProperties: value }, tags);
    }
    const free = tags.find((t) => t.name === "preserveUnknownFields");
    if (free) {
      if (!free.text) throw new Error(`${path}: @preserveUnknownFields needs a reason`);
      return applyTags({ type: "object", "x-kubernetes-preserve-unknown-fields": true }, tags);
    }
    return applyTags(this.type(type, path), tags);
  }

  type(type: ts.Type, path: string): Schema {
    const c = this.checker;
    const f = type.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) throw new Error(`${path}: free-form type needs @preserveUnknownFields <reason>`);
    if (f & ts.TypeFlags.String) return { type: "string", minLength: 1 };
    if (f & ts.TypeFlags.Number) return { type: "integer" };
    if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return { type: "boolean" };
    if (type.isStringLiteral()) return { type: "string", enum: [type.value] };
    if (type.isNumberLiteral()) return { type: "integer", enum: [type.value] };
    if (type.isUnion()) {
      const members = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
      if (members.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) return { type: "boolean" };
      if (members.every((t) => t.isStringLiteral())) return { type: "string", enum: members.map((t) => (t as ts.StringLiteralType).value) };
      if (members.every((t) => t.isNumberLiteral())) return { type: "integer", enum: members.map((t) => (t as ts.NumberLiteralType).value) };
      if (members.length === 1) return this.type(members[0], path);
      if (members.every((t) => (t.flags & ts.TypeFlags.Object || t.isIntersection()) && !c.isArrayType(t))) return this.object(members, path, type);
      throw new Error(`${path}: mixed union needs @preserveUnknownFields <reason>`);
    }
    if (c.isArrayType(type)) return { type: "array", items: this.type(c.getTypeArguments(type as ts.TypeReference)[0], `${path}[]`) };
    if (f & ts.TypeFlags.Object || type.isIntersection()) return this.object([type], path, type);
    throw new Error(`${path}: unsupported type ${c.typeToString(type)}`);
  }

  /** A union of object shapes (e.g. "either A or B") becomes one object whose required fields are common to all. */
  private object(members: ts.Type[], path: string, whole: ts.Type): Schema {
    const c = this.checker;
    const index = members.length === 1 ? c.getIndexInfoOfType(members[0], ts.IndexKind.String) : undefined;
    const properties: Record<string, Schema> = {};
    let required: string[] | undefined;
    for (const member of members) {
      const own: string[] = [];
      for (const p of c.getPropertiesOfType(member)) {
        const s = this.property(p, `${path}.${p.name}`);
        if (!s) continue;
        properties[p.name] ??= s;
        if (!(p.flags & ts.SymbolFlags.Optional)) own.push(p.name);
      }
      required = required ? required.filter((r) => own.includes(r)) : own;
    }
    if (index && !Object.keys(properties).length) {
      return applyTags({ type: "object", additionalProperties: this.type(index.type, `${path}{}`) }, tagsOf(whole.aliasSymbol ? undefined : whole.symbol));
    }
    const out: Schema = { type: "object", properties };
    if (required?.length) out.required = required;
    const symbol = whole.symbol ?? whole.aliasSymbol;
    return symbol && symbol.flags & ts.SymbolFlags.Interface ? applyTags(out, tagsOf(symbol)) : out;
  }
}

function specSchemas(): Record<string, Schema> {
  const options: ts.CompilerOptions = { strict: true, allowImportingTsExtensions: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options, true);
  host.jsDocParsingMode = ts.JSDocParsingMode.ParseAll;
  const program = ts.createProgram({ rootNames: [MODEL], options, host });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(MODEL);
  if (!file) throw new Error(`cannot read ${MODEL}`);
  const exports = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(file)!).map((s) => [s.name, s]));
  const walker = new Walker(checker);
  const out: Record<string, Schema> = {};
  for (const [kind, c] of Object.entries(DEFINITION_CRDS)) {
    const symbol = exports.get(`${kind}Spec`);
    if (!symbol) throw new Error(`model/kinds.ts exports no ${kind}Spec`);
    const s = walker.type(checker.getDeclaredTypeOfSymbol(symbol), kind);
    if (c.document) {
      s.properties = { ...(s.properties as Record<string, Schema>), body: { type: "string", minLength: 1, description: "Markdown body (the file body in Git mode)" } };
      s.required = [...((s.required as string[]) ?? []), "body"];
    }
    out[kind] = s;
  }
  return out;
}

export function generateCrds(): string {
  const schemas = specSchemas();
  return Object.entries(DEFINITION_CRDS)
    .map(([kind, c]) =>
      stringify({
        apiVersion: "apiextensions.k8s.io/v1",
        kind: "CustomResourceDefinition",
        metadata: { name: `${c.plural}.${CRD_GROUP}` },
        spec: {
          group: CRD_GROUP,
          scope: "Namespaced",
          names: { kind, plural: c.plural, singular: kind.toLowerCase() },
          versions: [
            {
              name: CRD_VERSION,
              served: true,
              storage: true,
              schema: { openAPIV3Schema: { type: "object", required: ["spec"], properties: { spec: schemas[kind] } } },
            },
          ],
        },
      }),
    )
    .join("---\n");
}
