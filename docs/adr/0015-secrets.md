# ADR-0015: Secrets are referenced, never stored as resources

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
Sources (GitHub, Jira), model providers, and repositories need credentials. Resources are stored in Git (definitions) and
in the DB (runtime), are shown in the UI, and are fed to agents. Secrets must never leak through any of these.

## Decision
- Resources only hold a **`secretRef: { name }`**. Secret values are never stored in any resource, Event, Artifact,
  transcript, or log.
- Values come from the **`SecretResolver`** port. MVP adapter: environment variables. The name is upper-cased and `-`
  becomes `_` (`anthropic-api-key` → `ANTHROPIC_API_KEY`), and a local `.env` file (gitignored) is supported.
  Later: Vault, a cloud secret manager, or Kubernetes Secrets, as additional adapters behind the same port.
- There is no `Secret` kind. The UI may show *whether* a referenced secret resolves (✓/✗), never its value.
- Every resolved value is registered with the `Redactor` (ADR-0012), which masks it in transcripts, events, and errors.
- Agents never receive secrets in prompts. Adapters use them outside the model context.
- Admission warns, and does not fail, when a `secretRef` can't be resolved, so definitions stay portable across environments.

## Consequences
Definitions are safe to commit and show. Operators manage secrets outside the factory.

## Alternatives considered
A `Secret` kind in the DB (encrypted): needs key management, and it's a leak risk through the generic resource UI and API. Rejected for now.
