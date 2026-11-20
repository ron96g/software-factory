import { stringify } from "yaml";
import { specSchema } from "./crd-schemas.ts";
import { CRD_GROUP, CRD_VERSION, DEFINITION_CRDS } from "./cr-mapper.ts";

/** deploy/kubernetes/crds.yaml is generated from DEFINITION_CRDS (the mapper's registry), so CRDs cannot drift from the code. */
export function generateCrds(): string {
  return Object.entries(DEFINITION_CRDS)
    .map(([kind, c]) => {
      const spec = specSchema(kind, c.document);
      return stringify({
        apiVersion: "apiextensions.k8s.io/v1",
        kind: "CustomResourceDefinition",
        metadata: { name: `${c.plural}.${CRD_GROUP}` },
        spec: {
          group: CRD_GROUP,
          scope: "Namespaced",
          names: { kind, plural: c.plural, singular: kind.toLowerCase() },
          versions: [
            {
              name: CRD_VERSION,
              served: true,
              storage: true,
              schema: { openAPIV3Schema: { type: "object", required: ["spec"], properties: { spec } } },
            },
          ],
        },
      });
    })
    .join("---\n");
}
