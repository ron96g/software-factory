# ADR-0071: Kubernetes CR backend for definitions

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** project owner
- **Extends:** ADR-0011, ADR-0015

## Context
Definitions can be managed by a GitOps tool (e.g. Argo CD) in a cluster. Runtime objects stay in SQLite.

## Decision
- `FACTORY_DEFINITION_SOURCE=git|kubernetes` (default `git`). Kubernetes mode reads definition CRs (group `factory.ai-dlc.io`, `v1alpha1`; manifests in `deploy/kubernetes/`) through a `DefinitionFeed` and live-reloads them through `ReloadingDefinitionStore` (atomic snapshot swap; last good snapshot kept when validation fails).
- Agent and Skill carry their Markdown body in `spec.body`.
- Secrets: CRs only hold `secretRef: { name }`. `NamespacedSecretResolver` resolves them from exactly one configured secret namespace and refuses refs naming another. RBAC: a ClusterRole with get/list/watch on the definition CRDs only, plus a namespaced Role/RoleBinding for Secrets in that namespace. No cluster-wide Secret access.
- The factory never writes to the CRs.

## Consequences
The Kubernetes client dependency is covered by the security scan. Definitions may change mid-run; versions used are recorded, not frozen.

## CRD schema sync

`deploy/kubernetes/crds.yaml` is generated from `DEFINITION_CRDS` (`web/src/core/store/cr-mapper.ts`) by `web/src/core/store/crd-generator.ts` (`npm run gen:crds`). A unit test fails when the committed file differs from the generator output, so CRDs cannot drift from the code's kind registry. Each kind has a strictly typed structural `spec` schema in `web/src/core/store/crd-schemas.ts` (mirroring `model/kinds.ts`) with CEL rules (`x-kubernetes-validations`), e.g. a `human-approval` gate needs approvers, a `Repository` needs `git` or `local`, `http` tool servers need a `url`. Agent and Skill CRDs require a non-empty `spec.body`. Only declared free-form maps (e.g. `connection`, `jsonSchema`) preserve unknown fields. Regeneration is manual (`npm run gen:crds`); the drift test enforces it. Keeping the schema file aligned with `kinds.ts` is a review duty.
