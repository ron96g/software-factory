/**
 * ADR-0062 §3: the check worker process. It builds the same factory as the web app but registers **only** the CheckRun
 * execution controller, so a web restart never interrupts a check and checks never compete with the UI. Run it alongside
 * the web app over the same database:
 *
 *   npm run worker
 *
 * The web app should run with `FACTORY_ROLE=web` so it does not also execute checks; without a worker, checks stay
 * Pending with the reason "no check worker".
 */
import { resolve } from "node:path";
import { createFactory } from "../src/core/factory.ts";

const root = process.env.FACTORY_ROOT ?? resolve(process.cwd(), "..");
const factory = await createFactory({
  role: "worker",
  definitionsRoot: root,
  databasePath: process.env.FACTORY_DB ?? resolve(process.cwd(), "data/factory.db"),
  log: (msg, err) => console.warn(`[worker] ${msg}`, err instanceof Error ? err.message : (err ?? "")),
});

await factory.start();
console.log(`[worker] started (definitions: ${root}, database: ${process.env.FACTORY_DB ?? "data/factory.db"})`);

const shutdown = (signal: string) => {
  console.log(`[worker] ${signal}: stopping`);
  void factory.stop().then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
