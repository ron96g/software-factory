import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const dir = "src/integration";
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.ts")) : [];
if (files.length === 0) { console.error(`No integration tests in ${dir}`); process.exit(1); }
process.exit(spawnSync("node", ["--test", `${dir}/*.test.ts`], { stdio: "inherit", shell: true }).status ?? 1);
