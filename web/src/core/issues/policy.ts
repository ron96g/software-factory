import type { SourceWritePolicy } from "../ports/index.ts";

export const CREATE_ISSUE_ACTION = "create-issue";

export const createIssuePolicy: SourceWritePolicy = {
  check: (s) => (s.spec.writeBack?.issues ? undefined : "issue creation is not permitted"),
};
