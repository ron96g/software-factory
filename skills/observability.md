---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: observability
spec:
  description: Monitor a release and convert anomalies into feedback signals.
---

# Observability

1. Watch the SLIs (latency, error rate, saturation) during the bake time.
2. Compare them against the pre-release baseline and the error budget.
3. On regression, recommend or trigger a rollback.
4. Emit a `signal` with the evidence (graphs, logs, traces) so that triage can pick it up.
