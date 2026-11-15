export interface JsonSchemaValidator {
  /** Invalid schemas throw; invalid values return actionable validation errors. No remote references are loaded. */
  validate(schema: Record<string, unknown>, value: unknown): string | undefined;
}

export interface ArtifactSchemaReader {
  get(type: string, namespace: string): Promise<{
    version: string;
    digest: string;
    jsonSchema: Record<string, unknown>;
  } | undefined>;
}
