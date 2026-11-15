import { nsOf } from "../model/meta.ts";
import type { ArtifactSchemaReader, ContextProvider } from "../ports/index.ts";

export function artifactSchemaContext(schemas: ArtifactSchemaReader): ContextProvider {
  return {
    name: "artifact-schemas",
    appliesTo: (ctx) => !!ctx.run.spec.outputs.length,
    async provide(ctx) {
      const sections = [];
      for (const type of new Set(ctx.run.spec.outputs.map((output) => output.name))) {
        const schema = await schemas.get(type, nsOf(ctx.workItem));
        if (schema) sections.push({
          title: `Required JSON contract: ${type}`, source: `artifact-schema:${type}`, revision: schema.digest,
          content: JSON.stringify({
            instructions: "Return this artifact's content as a JSON-encoded string matching this exact schema. No Markdown fences or extra properties. If the schema calls for input artifact references, use the exact names and resourceVersions below. Do not invent references. Validation errors are returned to this producing step for correction; preserve unrelated valid content when retrying.",
            version: schema.version, schema: schema.jsonSchema,
            inputs: ctx.inputs.map((artifact) => ({ name: artifact.metadata.name, resourceVersion: artifact.metadata.resourceVersion,
              type: artifact.spec.artifactTypeRef.name })),
          }, null, 2),
        });
      }
      return sections;
    },
  };
}
