import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
test("check scripts are non-trivial", () => {
  for (const [name, file] of [["test:integration", "check-integration"], ["test:acceptance", "check-acceptance"]]) {
    const s: string = pkg.scripts[name];
    assert.ok(s && s.includes(`scripts/${file}.mjs`), name);
    assert.doesNotMatch(s, /^(true|exit 0|echo)/);
    const body = readFileSync(`scripts/${file}.mjs`, "utf8");
    assert.match(body, /process\.exit\(1\)/);
    assert.match(body, /--test/);
  }
  assert.match(readFileSync("scripts/check-acceptance.mjs", "utf8"), /AC-/);
});
