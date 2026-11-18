import type { Source } from "../model/kinds.ts";
import type { SourceConnector } from "./integration.ts";

/** What a connector needs to create one issue; the marker carries the proposal uid (a hint, not proof). */
export interface IssueDraft {
  title: string;
  /** Markdown. */
  body: string;
  issueType?: string;
  labels?: string[];
  marker: string;
}

export interface CreatedIssue {
  externalId: string;
  url?: string;
}

export interface IssueCreator {
  createIssue(source: Source, draft: IssueDraft): Promise<CreatedIssue>;
}

/** Lookup only; never creates. Used to recover after an unknown outcome. */
export interface IssueFinder {
  findCreatedIssues(source: Source, query: { marker: string; createdAfter: string }): Promise<CreatedIssue[]>;
}

export const canCreateIssues = (c: SourceConnector): c is SourceConnector & IssueCreator =>
  typeof (c as Partial<IssueCreator>).createIssue === "function";
export const canFindIssues = (c: SourceConnector): c is SourceConnector & IssueFinder =>
  typeof (c as Partial<IssueFinder>).findCreatedIssues === "function";

/** ADR-0066 §6: lets the syncer skip an issue whose mirror proposal is not linked to its work item yet. */
export interface MirrorLinkChecker {
  isUnlinkedMirror(description: string | undefined): Promise<boolean>;
}
