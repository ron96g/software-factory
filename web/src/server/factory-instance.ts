import "server-only";
import { resolve } from "node:path";
import { createFactory, type Factory } from "@/core/factory.ts";

/** Process-wide singleton (survives Next.js dev HMR via globalThis). */
const g = globalThis as unknown as { __factory?: Promise<Factory> };

export function getFactory(): Promise<Factory> {
  g.__factory ??= (async () => {
    const root = process.env.FACTORY_ROOT ?? resolve(process.cwd(), "..");
    const f = await createFactory({
      definitionsRoot: root,
      databasePath: process.env.FACTORY_DB ?? resolve(process.cwd(), "data/factory.db"),
      log: (msg, err) => console.warn(msg, err instanceof Error ? err.message : (err ?? "")),
    });
    await f.start();
    console.log(`[factory] started (definitions: ${root})`);
    return f;
  })();
  return g.__factory;
}
