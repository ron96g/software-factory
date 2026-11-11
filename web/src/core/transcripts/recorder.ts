import type { AgentRun, Conversation } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type {
  NewTranscriptMessage,
  Redactor,
  SecretResolver,
  TranscriptRecorder,
  TranscriptRecorderFactory,
  TranscriptRef,
  TranscriptWriter,
} from "../ports/index.ts";
import type { Ref } from "../model/resource.ts";

/** Masks every secret value that was resolved through the tracking resolver (ADR-0015). */
export class SecretRedactor implements Redactor {
  private readonly values = new Set<string>();
  add(value: string): void {
    if (value && value.length >= 6) this.values.add(value);
  }
  redact(text: string): string {
    let out = text;
    for (const v of this.values) out = out.split(v).join("«redacted»");
    return out;
  }
}

/** Decorator: registers every resolved secret with the redactor. */
export class RedactingSecretResolver implements SecretResolver {
  private readonly inner: SecretResolver;
  private readonly redactor: SecretRedactor;
  constructor(inner: SecretResolver, redactor: SecretRedactor) {
    this.inner = inner;
    this.redactor = redactor;
  }
  resolve(ref: Ref | undefined): string | undefined {
    const v = this.inner.resolve(ref);
    if (v) this.redactor.add(v);
    return v;
  }
}

class BoundRecorder implements TranscriptRecorder {
  readonly ref: TranscriptRef;
  private readonly writer: TranscriptWriter;
  private readonly redactor: Redactor;
  constructor(ref: TranscriptRef, writer: TranscriptWriter, redactor: Redactor) {
    this.ref = ref;
    this.writer = writer;
    this.redactor = redactor;
  }
  async record(m: NewTranscriptMessage): Promise<void> {
    await this.writer.append(this.ref, { ...m, content: this.redactor.redact(m.content) });
  }
}

/** Reuses the transcript referenced in status (restart-safe), otherwise opens a new one. */
export class DefaultRecorderFactory implements TranscriptRecorderFactory {
  private readonly writer: TranscriptWriter;
  private readonly redactor: Redactor;
  constructor(writer: TranscriptWriter, redactor: Redactor) {
    this.writer = writer;
    this.redactor = redactor;
  }
  async forRun(run: AgentRun): Promise<TranscriptRecorder> {
    const ref = run.status?.transcriptRef ?? (await this.writer.open(nsOf(run), { kind: "AgentRun", name: run.metadata.name }));
    return new BoundRecorder(ref, this.writer, this.redactor);
  }
  async forConversation(c: Conversation): Promise<TranscriptRecorder> {
    const ref = c.status?.transcriptRef ?? (await this.writer.open(nsOf(c), { kind: "Conversation", name: c.metadata.name }));
    return new BoundRecorder(ref, this.writer, this.redactor);
  }
}
