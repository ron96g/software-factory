# ADR-0009: Authentication & authorization (role tags + squads)

- **Status:** Accepted (implementation deferred to milestone M7)
- **Date:** 2026-11-11

## Context
Work items belong to teams. Users must only see and edit what they are entitled to. We don't want to manage passwords.

## Decision

### Authentication
- Only a trusted external **OAuth2/OIDC IdP** (Authorization Code + PKCE). No local passwords.
- On login, the identity becomes a `User` resource (keyed by issuer + subject). Its email and name come from ID-token claims.

### Model (new runtime/definition kinds)
| Kind | Purpose |
|---|---|
| `User` | `spec`: `subject`, `issuer`, `email`, `displayName`, `roles: string[]`, `squadRefs: Ref[]` |
| `Role` | A configurable **tag** with a set of permissions, e.g. `ProductOwner`, `Engineer`, `TechLead`, `OpsLead`, `Admin` |
| `Squad` | A team: `spec.members` (or users carry `squadRefs`), plus optional default `repositoryRefs` and `sourceRefs` |

- A user can have **multiple roles** (tags) and belong to **one or more squads**.
- Roles can optionally be mapped from IdP group claims (`Role.spec.idpGroups`), in addition to manual assignment.

### Authorization
- **RBAC:** a role grants verbs on kinds, e.g. `{ kinds: [WorkItem], verbs: [get, list, create, update] }`,
  `{ kinds: [Approval], verbs: [decide], when: { gateRole: ProductOwner } }`.
- **Squad scoping:** runtime objects carry `spec.squadRefs` (WorkItems inherit them from `Source`/`Repository`/`Squad`
  defaults through admission). A user can only see and edit objects whose squads intersect with their own. `Admin` bypasses this.
- Gate approvers (`gate.approvers[].role`) and `Agent.spec.humanCounterpart.role` reference the **same role tags**.
  Clarification and approval assignment uses them, together with squad membership.

### Enforcement (ports, defined in M7)
- `Authenticator`: request → `Principal { user, roles, squads }`.
- `Authorizer`: `(principal, verb, resource) → allow | deny`.
- `ScopedReader`: a decorator over `ResourceReader` that applies squad filtering to `list` and `get`.
- Enforcement happens at the API boundary and in the decorator. Core controllers run as a system principal.

## Consequences (binding until M7)
- No global "current user". Every API entry point must be able to accept a `Principal`.
- New runtime queries must be filterable by label or field selector (squad scoping will use them).
- The `role` strings already used in workflows and agents must match the future `Role` names.

## Alternatives considered
Local accounts: rejected (security burden). Squad-only access without roles: too coarse for approvals.
