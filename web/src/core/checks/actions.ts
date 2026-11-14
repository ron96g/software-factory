import { createHash } from "node:crypto";
import type { AgentRun, CheckRun, Repository, SandboxProfile, WorkItem, Workspace } from "../model/kinds.ts";
import { API_VERSION } from "../model/resource.ts";
import { nsOf, ownerRef } from "../model/meta.ts";
import { StoreError, isStoreError, type CheckRunCommands, type CheckRunQueries, type ExecutionEnvironmentSelector, type ModuleScopePlanner, type Principal, type Redactor, type ResourceReader, type ResourceWriter, type TranscriptReader, type WorkspaceSnapshotter } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { checkConfig, resolveCheckConfig } from "./config.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stopped = (item: WorkItem) => ["Failed", "Done", "Closed"].includes(item.status?.phase ?? "") &&
  (!item.spec.restart || item.spec.restart.id === item.status?.restartHandled);

export interface CheckActionsDeps {
  namespace: string;
  reader: ResourceReader;
  writer: ResourceWriter;
  transcripts: TranscriptReader;
  snapshots: WorkspaceSnapshotter;
  environments: ExecutionEnvironmentSelector;
  redactor: Redactor;
  scopes?: ModuleScopePlanner;
}

export class CheckActions implements CheckRunCommands, CheckRunQueries {
  private readonly d: CheckActionsDeps;
  private readonly submitting = new Set<string>();
  constructor(d: CheckActionsDeps) { this.d = d; }

  private async item(name: string) {
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.d.namespace, name);
    if (!item) throw new StoreError(`work item ${name} not found`, "NotFound");
    return item;
  }

  async inspect(_p: Principal, name: string) {
    const item = await this.item(name);
    const ownedBy = { kind: "WorkItem", name, namespace: this.d.namespace };
    const runs = (await this.d.reader.list<CheckRun>("CheckRun", { namespace: this.d.namespace, ownedBy }))
      .filter((run) => run.spec.workItemUid === item.metadata.uid);
    const options = [];
    if (stopped(item)) {
      for (const ws of await this.d.reader.list<Workspace>("Workspace", { namespace: this.d.namespace, ownedBy })) {
        if (ws.status?.phase !== "Ready" || !ws.metadata.ownerReferences?.some((o) => o.uid === item.metadata.uid)) continue;
        const repo = await resolveRef<Repository>(this.d.reader, "Repository", ws.spec.repositoryRef, this.d.namespace);
        if (!repo) throw new StoreError(`repository ${ws.spec.repositoryRef.name} not found`, "NotFound");
        for (const check of Object.keys(repo.spec.checks ?? {})) {
          options.push({ workspace: ws.metadata.name, repository: repo.metadata.name, check, timeoutMs: checkConfig(repo, check).timeoutMs });
        }
      }
    }
    return { runs, options };
  }

  async logs(_p: Principal, name: string, afterSeq = 0) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new StoreError("afterSeq must be a non-negative integer", "Invalid");
    const run = await this.d.reader.get<CheckRun>("CheckRun", this.d.namespace, name);
    if (!run) throw new StoreError(`check ${name} not found`, "NotFound");
    const item = await this.item(run.spec.workItemRef.name);
    if (item.metadata.uid !== run.spec.workItemUid) throw new StoreError("check origin no longer exists", "NotFound");
    const ref = run.status?.logRef;
    if (!ref) return [];
    if (ref.namespace !== this.d.namespace) throw new StoreError("check log namespace mismatch", "Invalid");
    return this.d.transcripts.read(ref, { afterSeq, limit: 50 });
  }

  async submit(p: Principal, name: string, input: { workspace: string; check: string; requestId: string }) {
    if (!input.requestId?.trim() || input.requestId.length > 200 || !input.workspace?.trim() || !input.check?.trim()) {
      throw new StoreError("requestId, workspace and check are required", "Invalid");
    }
    const key = `check-${hash([name, input.requestId])}`;
    const fingerprint = hash([name, input.workspace, input.check, p.id]);
    const existing = await this.d.reader.get<CheckRun>("CheckRun", this.d.namespace, key);
    if (existing) {
      const currentItem = await this.item(name);
      if (existing.spec.requestFingerprint !== fingerprint || existing.spec.workItemUid !== currentItem.metadata.uid) {
        throw new StoreError("check request ID was already used with different input or origin", "Conflict");
      }
      return existing;
    }
    const lock = `${this.d.namespace}/${name}`;
    if (this.submitting.has(lock)) throw new StoreError("another check submission is in progress; retry this request", "Conflict");
    this.submitting.add(lock);
    try {
      const item = await this.item(name);
      if (!stopped(item)) throw new StoreError("standalone checks require a stopped (Failed, Done or Closed) work item", "Conflict");
      const workspace = await this.d.reader.get<Workspace>("Workspace", this.d.namespace, input.workspace);
      if (!workspace || workspace.status?.phase !== "Ready" ||
          !workspace.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === item.metadata.uid)) {
        throw new StoreError("a Ready workspace owned by this work item is required", "Invalid");
      }
      const active = await this.d.reader.list<CheckRun>("CheckRun", { namespace: this.d.namespace, ownedBy: { kind: "WorkItem", name, namespace: this.d.namespace } });
      if (active.some((r) => !r.status || r.status.phase === "Running")) throw new StoreError("a standalone check is already pending or running", "Conflict");
      const agents = await this.d.reader.list<AgentRun>("AgentRun", { namespace: this.d.namespace, ownedBy: { kind: "WorkItem", name, namespace: this.d.namespace } });
      if (agents.some((r) => ["Running", "Pending"].includes(r.status?.phase ?? "Pending"))) {
        throw new StoreError("work item still has active agent runs", "Conflict");
      }
      const repo = await resolveRef<Repository>(this.d.reader, "Repository", workspace.spec.repositoryRef, this.d.namespace);
      if (!repo) throw new StoreError("workspace repository not found", "NotFound");
      const config = await resolveCheckConfig(repo, input.check, workspace, this.d.scopes);
      if (this.d.redactor.redact(config.command) !== config.command) throw new StoreError("check command contains a factory secret", "Invalid");
      const profile = repo.spec.sandboxRef && await resolveRef<SandboxProfile>(this.d.reader, "SandboxProfile", repo.spec.sandboxRef, this.d.namespace);
      if (repo.spec.sandboxRef && !profile) throw new StoreError("sandbox profile not found", "NotFound");
      const { health } = await this.d.environments.select();
      const snapshot = await this.d.snapshots.fingerprint(workspace);
      const current = await this.item(name);
      if (current.metadata.resourceVersion !== item.metadata.resourceVersion) throw new StoreError("work item changed during check submission", "Conflict");
      const run: CheckRun = {
        apiVersion: API_VERSION, kind: "CheckRun",
        metadata: { name: key, namespace: this.d.namespace, ownerReferences: [ownerRef(item)] },
        spec: {
          workItemRef: { name }, workItemUid: item.metadata.uid!,
          workspaceRef: { name: workspace.metadata.name }, workspaceUid: workspace.metadata.uid!,
          repositoryRef: { name: repo.metadata.name, namespace: nsOf(repo) === nsOf(item) ? undefined : nsOf(repo) }, repositoryVersion: repo.metadata.resourceVersion!,
          check: input.check, ...config, snapshot,
          environment: { runtime: health.runtime, version: health.version, profileVersion: profile?.metadata.resourceVersion ?? "default" },
          requestedBy: p.id, requestFingerprint: fingerprint,
        },
      };
      try { return await this.d.writer.create(run); }
      catch (e) {
        if (!isStoreError(e, "AlreadyExists")) throw e;
        const duplicate = await this.d.reader.get<CheckRun>("CheckRun", this.d.namespace, key);
        if (!duplicate || duplicate.spec.requestFingerprint !== fingerprint) throw new StoreError("conflicting concurrent check request", "Conflict");
        return duplicate;
      }
    } finally { this.submitting.delete(lock); }
  }
}
