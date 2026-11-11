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
    "artifactRef": "ArtifactType",
    "sourceRef": "Source",
    "sourceRefs": "Source",
    "repositoryRefs": "Repository",
    "providerRef": "ModelProvider",
    "sandboxRef": "SandboxProfile",
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
        if {".venv", "node_modules", ".next", ".serena"} & set(path.parts):
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

    for e in errors:
        print("ERROR", e)
    print(f"{len(index)} resources, {len(errors)} errors")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
