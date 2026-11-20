import { writeFileSync } from "node:fs";
import { generateCrds } from "../src/core/store/crd-generator.ts";

writeFileSync(new URL("../../deploy/kubernetes/crds.yaml", import.meta.url), generateCrds());
