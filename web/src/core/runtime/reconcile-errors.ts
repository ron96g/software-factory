import { parseKey } from "../model/meta.ts";
import type {
  Clock,
  ControllerHealth,
  EventRecorder,
  FailingReconcile,
  Redactor,
  ReconcileErrorReporter,
  ReconcileFailure,
  ResourceReader,
} from "../ports/index.ts";

/**
 * Q2: makes repeated reconcile failures visible. A Warning event goes on the affected object at the threshold
 * attempt and then every `every` attempts (no event spam); recovery emits a Normal event. Messages are redacted.
 */
export class EventingReconcileErrorReporter implements ReconcileErrorReporter, ControllerHealth {
  private readonly current = new Map<string, FailingReconcile>();
  private readonly d: { reader: ResourceReader; events: EventRecorder; redactor: Redactor; clock: Clock; threshold?: number; every?: number };
  constructor(d: EventingReconcileErrorReporter["d"]) {
    this.d = d;
  }

  failing(): FailingReconcile[] {
    return [...this.current.values()].filter((f) => f.attempts >= (this.d.threshold ?? 3));
  }

  async failed(f: ReconcileFailure): Promise<void> {
    const id = `${f.controller}|${f.key}`;
    const lastError = this.d.redactor.redact(f.error instanceof Error ? f.error.message : String(f.error)).slice(0, 1500);
    const prev = this.current.get(id);
    this.current.set(id, {
      controller: f.controller,
      kind: f.kind,
      key: f.key,
      attempts: f.attempt,
      lastError,
      since: prev?.since ?? this.d.clock.now().toISOString(),
    });
    const threshold = this.d.threshold ?? 3;
    const every = this.d.every ?? 10;
    if (f.attempt !== threshold && (f.attempt < threshold || (f.attempt - threshold) % every !== 0)) return;
    const obj = await this.object(f.kind, f.key);
    if (obj) await this.d.events.warning(obj, "ReconcileFailing", `${f.controller}: attempt ${f.attempt} failed: ${lastError}`).catch(() => {});
  }

  recovered(controller: string, key: string): void {
    const id = `${controller}|${key}`;
    const prev = this.current.get(id);
    if (!prev) return;
    this.current.delete(id);
    if (prev.attempts < (this.d.threshold ?? 3)) return;
    void this.object(prev.kind, key).then((obj) => obj && this.d.events.normal(obj, "ReconcileRecovered", `${controller}: recovered after ${prev.attempts} failed attempt(s)`).catch(() => {}));
  }

  private async object(kind: string | undefined, key: string) {
    if (!kind || !key.includes("/")) return null;
    const { namespace, name } = parseKey(key);
    return this.d.reader.get(kind, namespace, name).catch(() => null);
  }
}
