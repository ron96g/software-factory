# Software Factory: AI-DLC as Code

A declarative software factory built around the **AI-Driven Development Lifecycle (AI-DLC)**:

| Phase            | Intent                                              | Key artifacts                        |
|------------------|-----------------------------------------------------|--------------------------------------|
| **Inception**    | Turn an *Intent* into requirements & Units of Work  | user stories, NFRs, units, risks     |
| **Construction** | Build each Unit in short *Bolts* (hours/days)       | domain model, design, code, tests    |
| **Operations**   | Deploy, observe, and feed learnings back            | IaC, deploy plan, runbooks, metrics  |

The rule is simple: **AI proposes, a human validates at each gate.**

## Resource model

Every artifact is a resource with the same envelope: `apiVersion`, `kind`, `metadata`, `spec`.
This gives every artifact a uniform address, so resources can reference each other.

| Kind         | Format                         | Location        | Purpose                                  |
|--------------|--------------------------------|-----------------|------------------------------------------|
| `Agent`      | Markdown + YAML frontmatter    | `agents/`       | Persona, responsibilities, skills it uses |
| `Skill`      | Markdown + YAML frontmatter    | `skills/`       | Reusable capability / procedure           |
| `Workflow`   | YAML custom resource           | `workflows/`    | Phases → stages → steps, gates, artifacts |
| `ArtifactType` | YAML custom resource         | `artifacts/`    | Typed outputs that flow between steps     |

`apiVersion: factory.ai-dlc.io/v1alpha1` for all kinds. Schemas are in `schemas/`.

### References

References follow the Kubernetes `*Ref` convention:

```yaml
agentRef:     { name: product-owner }          # → agents/product-owner.md
skillRefs:    [{ name: user-story-writing }]   # → skills/user-story-writing.md
workflowRef:  { name: construction-bolt }      # → sub-workflow
inputs:       [{ artifactRef: { name: user-stories } }]
```

Reference graph:

```mermaid
flowchart LR
  Workflow -- steps --> Agent -- skillRefs --> Skill
  Skill -- "requires (skill may require other skills)" --> Skill
  Workflow -- "workflowRef (composition, e.g. one Bolt per Unit)" --> SubWorkflow[Workflow]
  Workflow -- inputs/outputs --> ArtifactType
  Agent -- delegates --> Agent2["Agent (e.g. code-researcher)"]
  Source -- defaults --> Workflow
  Source -- defaults --> Repository
```

## Layout

```
agents/       Agent definitions (*.md)
skills/       Skill definitions (*.md)
workflows/    Workflow CRs (*.yaml)
artifacts/    ArtifactType CRs (*.yaml)
schemas/      JSON Schemas per kind
tools/        validate.py: checks schemas + resolves every reference
```

## Run it (MVP v0.1)

```bash
cd web
npm install
cp .env.example .env.local   # optional: OPENAI_API_KEY / ANTHROPIC_API_KEY / GITHUB_TOKEN
npm run dev                  # http://localhost:3000
npm test                     # node:test, store + control plane + agent pipeline
npm run typecheck
```

Without an LLM key, the factory still runs end to end. Classification and code research use deterministic
skill handlers (ripgrep over the `software-factory` repository itself), and the other agents are simulated.
Data lives in `web/data/factory.db`. Delete the file to reset.

## Validation

```bash
pip install pyyaml jsonschema
python tools/validate.py
```

## Extending

1. Add a skill → `skills/<name>.md`
2. Give it to an agent via `spec.skillRefs`
3. Use the agent in a workflow step via `agentRef`
4. Run `tools/validate.py`. Broken references fail the build, so this can run in CI.
