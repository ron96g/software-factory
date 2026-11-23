#!/usr/bin/env python3
"""Load all factory resources, validate their envelope, and resolve every *Ref."""
import json
import re
import sys
from pathlib import Path

import yaml
from jsonschema import validate, ValidationError, Draft202012Validator, SchemaError

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
        # Standalone components validate their own configuration schemas; deploy/ holds the generated CRDs and samples.
        if path.relative_to(ROOT).parts[0] in ("components", "deploy"):
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
        if doc["kind"] == "ArtifactType" and "schema" in doc["spec"]:
            contract = doc["spec"]["schema"]
            if (doc["spec"].get("format") != "json" or not isinstance(contract, dict)
                    or not isinstance(contract.get("version"), str) or not contract["version"].strip()
                    or not isinstance(contract.get("jsonSchema"), dict)):
                errors.append(f"{path}: ArtifactType schema requires JSON format, a version and a JSON Schema object")
            else:
                try:
                    Draft202012Validator.check_schema(contract["jsonSchema"])
                except SchemaError as e:
                    errors.append(f"{path}: invalid ArtifactType schema: {e.message}")

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

    # Verification policy gaps: checks policy relies on without a configured command can never pass
    # (same rule as web/src/core/model/verification-policy.ts). Waivable required gaps are warnings.
    warnings = []
    for path, doc in docs:
        if doc.get("kind") != "Repository":
            continue
        spec = doc.get("spec", {})
        policy = spec.get("verification") or {}
        commands = spec.get("checks") or {}
        name = doc["metadata"]["name"]
        for role in ("requiredChecks", "preflightChecks", "preparationChecks", "readinessChecks"):
            for check in policy.get(role) or []:
                if check in commands:
                    continue
                message = f"{path}: {name}/{check} ({role}) has no configured command and can never pass"
                if role == "requiredChecks" and check in (policy.get("waivableChecks") or []):
                    warnings.append(message + "; every item needs a waiver until it is configured")
                else:
                    errors.append(message)

        for entry in policy.get("autoWaive") or []:
            if entry.get("check") not in (policy.get("waivableChecks") or []):
                errors.append(f"{path}: {name}: autoWaive check '{entry.get('check')}' must be in waivableChecks")
            if entry.get("when") != "pre-existing":
                errors.append(f"{path}: {name}: autoWaive '{entry.get('check')}' needs when: pre-existing")

        # ADR-0061: tier-scoped checks and minScope (same rules as web/src/core/model/check-scope.ts and checks/config.ts).
        make_target = re.compile(r"^make [a-zA-Z0-9][a-zA-Z0-9_-]*$")
        for check, value in commands.items():
            if not isinstance(value, dict):
                continue
            scoped, legacy = value.get("scoped") is True, value.get("moduleScoped") is True
            if scoped and legacy:
                errors.append(f"{path}: {name}/{check} sets both scoped and the legacy moduleScoped")
            if (scoped or legacy) and (not spec.get("moduleScope") or not make_target.match(str(value.get("command", "")))):
                errors.append(f"{path}: {name}/{check} is module-scoped and requires moduleScope policy and a single named make target")
            if legacy:
                warnings.append(f"{path}: {name}/{check} uses legacy moduleScoped (always affected scope); migrate to scoped: true (ADR-0061)")
        min_scope = policy.get("minScope")
        if min_scope is not None:
            if not isinstance(min_scope, dict):
                errors.append(f"{path}: {name}: verification.minScope must be an object of tiers")
                min_scope = {}
            for tier, checks in min_scope.items():
                if tier not in ("readiness", "preparation", "verification"):
                    errors.append(f"{path}: {name}: verification.minScope: unknown tier '{tier}'")
                    continue
                if not isinstance(checks, dict):
                    errors.append(f"{path}: {name}: verification.minScope.{tier} must map checks to a scope")
                    continue
                for check, scope in checks.items():
                    value = commands.get(check)
                    where = f"{path}: {name}: verification.minScope.{tier}.{check}"
                    if scope not in ("affected", "full"):
                        errors.append(f"{where} must be 'affected' or 'full'")
                    elif value is None:
                        errors.append(f"{where}: check is not configured")
                    elif isinstance(value, dict) and value.get("moduleScoped") is True:
                        errors.append(f"{where}: legacy moduleScoped checks always run affected; declare scoped: true")
                    elif not (isinstance(value, dict) and value.get("scoped") is True):
                        errors.append(f"{where}: only scoped checks have a scope")

    for w in warnings:
        print("WARNING", w)
    for e in errors:
        print("ERROR", e)
    print(f"{len(index)} resources, {len(errors)} errors, {len(warnings)} warnings")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
