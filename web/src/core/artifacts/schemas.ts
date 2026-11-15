import { createHash } from "node:crypto";
import type { ArtifactType } from "../model/kinds.ts";
import type { ArtifactSchemaReader, ResourceReader } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

export class DefinitionArtifactSchemas implements ArtifactSchemaReader {
  private readonly reader: ResourceReader;
  constructor(reader: ResourceReader) { this.reader = reader; }

  async get(type: string, namespace: string) {
    const definition = await resolveRef<ArtifactType>(this.reader, "ArtifactType", { name: type }, namespace);
    const schema = definition?.spec.schema;
    if (!schema) return undefined;
    if (definition.spec.format !== "json" || !schema.version?.trim() || !schema.jsonSchema ||
        typeof schema.jsonSchema !== "object" || Array.isArray(schema.jsonSchema)) {
      throw new Error(`ArtifactType ${type}: a schema requires JSON format, a version and a JSON Schema object`);
    }
    return { ...schema, digest: createHash("sha256").update(JSON.stringify(schema)).digest("hex") };
  }
}
