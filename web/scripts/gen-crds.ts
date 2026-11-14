import { writeFileSync } from "node:fs";
import { renderManifests } from "../src/core/k8s/crds.ts";
writeFileSync(new URL("../../deploy/crds.yaml", import.meta.url), renderManifests());
