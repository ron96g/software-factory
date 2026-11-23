import assert from "node:assert/strict";
import { test } from "node:test";
import type { Repository } from "../../model/kinds.ts";
import { gitRemote } from "./git-auth.ts";

test("git reaches the remote through the factory's proxy and CA settings; the token is scoped to the auth env only (SEC-3)", () => {
  const repo = { metadata: { name: "r" }, spec: { git: { url: "https://github.com/o/r.git", secretRef: { name: "token" } } } } as unknown as Repository;
  const { env, authEnv } = gitRemote(repo, { resolve: () => "s3cret" }, {
    PATH: "/bin", HOME: "/home/f", https_proxy: "http://proxy:3128", NO_PROXY: "localhost", GIT_SSL_CAINFO: "/etc/ca.pem", FACTORY_DB_PASSWORD: "x",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(env.https_proxy, "http://proxy:3128");
  assert.equal(env.NO_PROXY, "localhost");
  assert.equal(env.GIT_SSL_CAINFO, "/etc/ca.pem");
  assert.equal(env.FACTORY_DB_PASSWORD, undefined);
  // SEC-2/P0-2: the untrusted repository config and the system attributes are neutralized.
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_ATTR_NOSYSTEM, "1");
  // SEC-3/P0-2: the credential is only in `authEnv` (fetch/push); local git never inherits it.
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  assert.match(authEnv.GIT_CONFIG_PARAMETERS!, /extraheader=AUTHORIZATION: basic /);
  assert.equal(authEnv.GIT_TERMINAL_PROMPT, "0");
});
