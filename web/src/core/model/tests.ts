import { createHash } from "node:crypto";

/** ADR-0079: stable, short identity of a test's name path, used to compare attempts without storing every name. */
export const testId = (name: string) => createHash("sha256").update(name).digest("hex").slice(0, 16);
export const TEST_PATH_SEPARATOR = " › ";
