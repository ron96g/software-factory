import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { JsonSchemaValidator } from "../../ports/schema.ts";

export class AjvSchemaValidator implements JsonSchemaValidator {
  private readonly ajv = new Ajv2020({ strict: true, allErrors: true, addUsedSchema: false });
  private readonly compiled = new Map<string, ValidateFunction>();

  validate(schema: Record<string, unknown>, value: unknown): string | undefined {
    const key = JSON.stringify(schema);
    let check = this.compiled.get(key);
    if (!check) {
      check = this.ajv.compile(schema);
      this.compiled.set(key, check);
    }
    if (check(value)) return undefined;
    const errors = check.errors ?? [];
    const details = errors.slice(0, 12).map((error) =>
      `${error.instancePath || "/"}: ${error.message} [${error.keyword}; ${JSON.stringify(error.params)}]`);
    if (errors.length > 12) details.push(`${errors.length - 12} further validation error(s); fix the listed errors and validate against the supplied schema.`);
    return `JSON Schema validation failed:\n${details.join("\n")}\nReturn the same artifact with these errors corrected; preserve unrelated valid content.`;
  }
}
