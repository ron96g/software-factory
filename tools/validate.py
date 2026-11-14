#!/usr/bin/env python3
"""Load all factory resources, validate their envelope, and resolve every *Ref."""
import json
import sys
from pathlib import Path

import yaml
from jsonschema import validate, ValidationError

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "schemas/common.schema.json").read_text())

REF_KINDS = {
    "agentRef": "Agent",
    "skillRefs": "Skill",
    "requires": "Skill",
    "workflowRef": "Workflow",
    "workflowRefs": "Workflow",
    "artifactRef": "ArtifactType",
    "sourceRef": "Source",
    "sourceRefs": "Source",
    "repositoryRefs": "Repository",
    "repositoryRef": "Repository",
    "workspaceRef": "Workspace",
    "providerRef": "ModelProvider",
    "sandboxRef": "SandboxProfile",
    "toolServerRefs": "ToolServer",
    "conversationRef": "Conversation",
}


def load_markdown(path):
    text = path.read_text()
    if not text.startswith("---"):
        raise ValueError(f"{path}: missing YAML frontmatter")
    _, front, _body = text.split("---", 2)
    return [yaml.safe_load(front)]


def load_all():
    docs = []
    for path in ROOT.glob("**/*.md"):
        if path.parent.name in ("agents", "skills") and path.parent.parent == ROOT:
            docs += [(path, d) for d in load_markdown(path)]
    for path in ROOT.glob("**/*.yaml"):
        # Standalone components validate their own configuration schemas.
        if path.relative_to(ROOT).parts[0] == "components":
            continue
        if {".venv", "node_modules", ".next", ".serena", "data", ".workspaces"} & set(path.relative_to(ROOT).parts):
            continue
        docs += [(path, d) for d in yaml.safe_load_all(path.read_text()) if d]
    return docs


def walk_refs(node):
    """Yield (refKey, name) for every reference anywhere in a spec."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in REF_KINDS:
                for ref in value if isinstance(value, list) else [value]:
                    if not isinstance(ref, dict) or "name" not in ref:
                        yield key, f"<malformed: {ref!r}>"
                        continue
                    yield key, ref["name"]
            yield from walk_refs(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk_refs(item)


def main():
    errors = []
    index = {}
    docs = load_all()
    for path, doc in docs:
        try:
            validate(doc, SCHEMA)
        except ValidationError as e:
            errors.append(f"{path}: {e.message}")
            continue
        key = (doc["kind"], doc["metadata"]["name"])
        if key in index:
            errors.append(f"{path}: duplicate {key}")
        index[key] = path

    for path, doc in docs:
        for ref_key, name in walk_refs({"spec": doc.get("spec", {}), "status": doc.get("status", {})}):
            if (REF_KINDS[ref_key], name) not in index:
                errors.append(f"{path}: unresolved {ref_key} -> {REF_KINDS[ref_key]}/{name}")

    # Step-level tool narrowing may only name tools the step's agent has (ADR-0022).
    agents = {d["metadata"]["name"]: d for _, d in docs if d.get("kind") == "Agent"}
    for path, doc in docs:
        if doc.get("kind") != "Workflow":
            continue
        for phase in doc["spec"].get("phases", []):
            for stage in phase.get("stages", []):
                for step in stage.get("steps", []) or []:
                    if "tools" not in step:
                        continue
                    agent = agents.get(step["agentRef"]["name"], {})
                    allowed = set(agent.get("spec", {}).get("tools", []) or [])
                    for t in step["tools"]:
                        if t not in allowed:
                            errors.append(f"{path}: step {step['name']}: tool '{t}' is not a tool of agent {step['agentRef']['name']}")

    # Per-agent model mappings must name existing agents (ADR-0028).
    for path, doc in docs:
        if doc.get("kind") == "ModelProvider":
            for a in (doc["spec"].get("agentModels") or {}):
                if a not in agents:
                    errors.append(f"{path}: agentModels: unknown agent '{a}'")

    for e in errors:
        print("ERROR", e)
    print(f"{len(index)} resources, {len(errors)} errors")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
