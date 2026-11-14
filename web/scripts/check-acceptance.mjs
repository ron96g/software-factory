import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const dir = "src/acceptance";
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.ts")) : [];
const text = files.map((f) => readFileSync(`${dir}/${f}`, "utf8")).join("\n");
const missing = [];
for (let i = 1; i <= 9; i++) if (!new RegExp(`\\bAC-${i}\\b`).test(text)) missing.push(`AC-${i}`);
if (missing.length) { console.error(`Missing acceptance tests: ${missing.join(", ")}`); process.exit(1); }
process.exit(spawnSync("node", ["--test", `${dir}/*.test.ts`], { stdio: "inherit", shell: true }).status ?? 1);
