/**
 * Structural OpenAPI schemas (with CEL rules) per definition kind, mirroring the spec types in model/kinds.ts.
 * Free-form maps that the types declare as Record<string, unknown> are the only places preserving unknown fields.
 */
type Schema = Record<string, unknown>;

const str = (extra: Schema = {}): Schema => ({ type: "string", ...extra });
const nonEmpty = (extra: Schema = {}): Schema => str({ minLength: 1, ...extra });
const bool = (): Schema => ({ type: "boolean" });
const int = (extra: Schema = {}): Schema => ({ type: "integer", ...extra });
const arr = (items: Schema, extra: Schema = {}): Schema => ({ type: "array", items, ...extra });
const strs = (): Schema => arr(nonEmpty());
const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});
const strMap = (): Schema => ({ type: "object", additionalProperties: { type: "string" } });
const free = (): Schema => ({ type: "object", "x-kubernetes-preserve-unknown-fields": true });
const rules = (...r: { rule: string; message: string }[]): Schema => ({ "x-kubernetes-validations": r });

const ref = (): Schema =>
  obj({ name: nonEmpty(), namespace: str({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" }) }, ["name"]);
const refs = (): Schema => arr(ref());

const route = (): Schema => obj({ next: nonEmpty(), block: nonEmpty(), end: nonEmpty() }, [], rules({
  rule: "[has(self.next), has(self.block), has(self.end)].filter(x, x).size() == 1",
  message: "exactly one of next, block, end must be set",
}));

const step = (): Schema =>
  obj({
    name: nonEmpty(),
    agentRef: ref(),
    skillRefs: refs(),
    tools: arr(str()),
    outcomes: strs(),
    model: obj({ tier: nonEmpty() }),
    inputs: arr(obj({ artifactRef: ref() }, ["artifactRef"])),
    outputs: arr(obj({ artifactRef: ref() }, ["artifactRef"])),
  }, ["name", "agentRef"]);

const gate = (): Schema =>
  obj({
    type: nonEmpty(),
    routes: { type: "object", additionalProperties: route() },
    approvers: arr(obj({ role: nonEmpty() }, ["role"])),
    criteria: strs(),
    checks: strs(),
    onReject: route(),
    onFailure: free(),
    publication: obj({ artifactRef: ref(), reviewStage: nonEmpty() }, ["artifactRef", "reviewStage"]),
  }, ["type"], rules({
    rule: "self.type != 'human-approval' || (has(self.approvers) && self.approvers.size() > 0)",
    message: "a human-approval gate needs at least one approver",
  }));

const stage = (): Schema =>
  obj({
    name: nonEmpty(),
    mode: nonEmpty(),
    loop: obj({
      when: obj({ outcome: nonEmpty() }, ["outcome"]),
      goto: nonEmpty(),
      maxAttempts: int({ minimum: 1 }),
    }, ["when", "goto", "maxAttempts"]),
    publish: obj({
      pullRequest: obj({
        draft: bool(),
        onConflict: obj({ next: nonEmpty(), maxAttempts: int({ minimum: 1 }) }, ["next"]),
      }),
    }),
    steps: arr(step()),
    gate: gate(),
    workflowRef: ref(),
    forEach: obj({ artifactRef: ref(), as: nonEmpty(), parallelism: int({ minimum: 1 }) }, ["artifactRef", "as"]),
  }, ["name"]);

const agent = (): Schema =>
  obj({
    role: nonEmpty(),
    retrospectiveFeedback: bool(),
    sandboxRef: ref(),
    model: obj({ tier: nonEmpty(), providerRef: ref() }),
    skillRefs: refs(),
    delegates: arr(obj({ agentRef: ref() }, ["agentRef"])),
    tools: arr(str()),
    toolServerRefs: refs(),
    chat: obj({ allowedTools: arr(str()) }, ["allowedTools"]),
    humanCounterpart: obj({ role: nonEmpty() }, ["role"]),
  }, ["role"]);

const workflow = (): Schema =>
  obj({
    recovery: free(),
    planning: obj({
      reviewStage: nonEmpty(),
      planFormat: free(),
      plannerStage: nonEmpty(),
      revisionStage: nonEmpty(),
      synthesisStage: nonEmpty(),
    }, ["reviewStage"], rules({
      rule: "has(self.plannerStage) != (has(self.revisionStage) || has(self.synthesisStage))",
      message: "set plannerStage, or revisionStage together with synthesisStage",
    }, {
      rule: "has(self.revisionStage) == has(self.synthesisStage)",
      message: "revisionStage and synthesisStage go together",
    })),
    verification: obj({
      planningStage: nonEmpty(),
      reviewStage: nonEmpty(),
      preflightStage: nonEmpty(),
      verifyStage: nonEmpty(),
      implementationStage: nonEmpty(),
      preparationStage: nonEmpty(),
      maxCodeAttempts: int({ minimum: 1 }),
      maxExecutionAttempts: int({ minimum: 1 }),
      retryDelayMs: int({ minimum: 0 }),
    }, ["planningStage", "reviewStage", "preflightStage", "verifyStage", "implementationStage", "maxCodeAttempts", "maxExecutionAttempts", "retryDelayMs"]),
    unitExecution: obj({
      barrierStage: nonEmpty(),
      maxCodeAttempts: int({ minimum: 1 }),
      maxExecutionAttempts: int({ minimum: 1 }),
    }, ["barrierStage", "maxCodeAttempts", "maxExecutionAttempts"]),
    timebox: nonEmpty(),
    trigger: obj({ sourceRefs: refs() }),
    phases: arr(obj({ name: nonEmpty(), stages: arr(stage()) }, ["name", "stages"]), { minItems: 1 }),
    humanInput: free(),
    loop: free(),
  }, ["phases"], rules({
    rule: "!has(self.unitExecution) || has(self.verification)",
    message: "unitExecution requires verification",
  }));

const repository = (): Schema =>
  obj({
    git: obj({ url: nonEmpty(), defaultBranch: nonEmpty(), secretRef: ref() }, ["url"]),
    local: obj({ path: nonEmpty() }, ["path"]),
    index: obj({ enabled: bool(), type: nonEmpty(), include: strs(), exclude: strs() }),
    context: obj({ docs: strs(), owners: arr(obj({ role: nonEmpty(), team: nonEmpty() }, ["role"])) }),
    observability: free(),
    sandboxRef: ref(),
    issueTrackerRef: ref(),
    checks: {
      type: "object",
      additionalProperties: {
        "x-kubernetes-preserve-unknown-fields": true,
        ...rules({
          rule: "type(self) == string || (type(self) == map && 'command' in self && type(self.command) == string)",
          message: "a check is a command string or an object with a command",
        }),
      },
    },
    moduleScope: obj({ graph: nonEmpty(), sharedPaths: strs(), nonBuildPaths: strs() }, ["graph", "sharedPaths"]),
    verification: obj({
      requiredChecks: strs(),
      preflightChecks: strs(),
      preparationChecks: strs(),
      waivableChecks: strs(),
      autoWaive: arr(free()),
      readinessChecks: strs(),
      minScope: { type: "object", additionalProperties: { type: "object", additionalProperties: str({ enum: ["affected", "full"] }) } },
    }, ["requiredChecks", "preflightChecks"]),
    workspace: obj({ baseRef: nonEmpty(), setup: strs() }),
  }, [], rules({
    rule: "has(self.git) || has(self.local)",
    message: "a repository needs a git remote or a local path",
  }));

const SCHEMAS: Record<string, () => Schema> = {
  Agent: agent,
  Skill: () => obj({ description: nonEmpty(), requires: refs() }, ["description"]),
  Workflow: workflow,
  ArtifactType: () =>
    obj({
      format: nonEmpty(),
      collection: bool(),
      description: str(),
      schema: obj({ version: nonEmpty(), jsonSchema: free() }, ["version", "jsonSchema"]),
    }, ["format"]),
  Source: () =>
    obj({
      type: nonEmpty(),
      connection: free(),
      sync: obj({ mode: str({ enum: ["webhook", "poll"] }), pollInterval: nonEmpty(), filter: free(), bidirectional: bool() }),
      mapping: strMap(),
      defaults: obj({ workflowRef: ref(), repositoryRefs: refs() }),
      writeBack: obj({
        replyVisibilities: arr(str({ enum: ["public", "internal"] })),
        transitions: bool(),
        issues: obj({
          project: nonEmpty(),
          issueType: nonEmpty(),
          labels: strs(),
          pickUpLabels: strs(),
          fields: free(),
          linkOrigin: bool(),
        }),
      }),
    }, ["type"], rules({
      rule: "!has(self.sync) || !has(self.sync.mode) || self.sync.mode != 'poll' || has(self.sync.pollInterval)",
      message: "poll mode needs sync.pollInterval",
    })),
  Repository: repository,
  ModelProvider: () =>
    obj({
      type: nonEmpty(),
      baseUrl: nonEmpty(),
      secretRef: ref(),
      models: { type: "object", additionalProperties: nonEmpty(), minProperties: 1 },
      agentModels: strMap(),
      default: bool(),
    }, ["type", "models"]),
  SandboxProfile: () =>
    obj({
      image: nonEmpty(),
      resources: obj({ cpu: nonEmpty(), memory: nonEmpty(), pids: int({ minimum: 1 }), timeout: nonEmpty() }),
      network: obj({ mode: str({ enum: ["none", "allowlist"] }), allow: strs() }, ["mode"], rules({
        rule: "self.mode == 'allowlist' || !has(self.allow) || self.allow.size() == 0",
        message: "allow is only valid with mode allowlist",
      })),
      filesystem: obj({ workspace: nonEmpty(), rootReadOnly: bool(), tmpfs: strs() }),
      user: nonEmpty(),
      env: strMap(),
      isolation: str({ enum: ["process", "container", "microvm"] }),
    }, ["image"]),
  KnowledgeSource: () =>
    obj({
      type: nonEmpty(),
      description: str(),
      local: obj({ path: nonEmpty() }, ["path"]),
      include: strs(),
      exclude: strs(),
      scope: free(),
    }, ["type"], rules({
      rule: "self.type != 'files' || has(self.local)",
      message: "a files knowledge source needs local.path",
    })),
  ToolServer: () =>
    obj({
      transport: str({ enum: ["http", "stdio"] }),
      url: nonEmpty(),
      command: nonEmpty(),
      args: arr(str()),
      secretRef: ref(),
      allowedTools: strs(),
      description: str(),
    }, ["transport"], rules({
      rule: "self.transport != 'http' || has(self.url)",
      message: "http transport needs url",
    }, {
      rule: "self.transport != 'stdio' || has(self.command)",
      message: "stdio transport needs command",
    })),
};

export function specSchema(kind: string, document: boolean): Schema {
  const make = SCHEMAS[kind];
  if (!make) throw new Error(`no spec schema for kind ${kind}`);
  const s = make();
  if (!document) return s;
  const props = { ...(s.properties as Record<string, Schema>), body: nonEmpty({ description: "Markdown body (the file body in Git mode)" }) };
  const required = [...((s.required as string[] | undefined) ?? []), "body"];
  return { ...s, properties: props, required };
}
