import type { Skill } from "../model/kinds.ts";
import type { Ref } from "../model/resource.ts";
import type { ResourceReader } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

export async function resolveSkills(reader: ResourceReader, refs: Ref[], namespace: string): Promise<Skill[]> {
  const found = new Map<string, Skill>();
  const visit = async (ref: Ref) => {
    const key = `${ref.namespace ?? namespace}/${ref.name}`;
    if (found.has(key)) return;
    const skill = await resolveRef<Skill>(reader, "Skill", ref, namespace);
    if (!skill) throw new Error(`skill "${ref.name}" not found`);
    found.set(key, skill);
    for (const required of skill.spec.requires ?? []) await visit(required);
  };
  for (const ref of refs) await visit(ref);
  return [...found.values()];
}
