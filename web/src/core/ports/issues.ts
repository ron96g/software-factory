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

/** ADR-0068: read-only snapshot of a created ticket; never writes. */
export interface IssueStatus {
  state: string;
  /** False once the tracker reports the ticket closed or resolved. */
  open: boolean;
  assignee?: string;
  updatedAt?: string;
}

export interface IssueStatusReader {
  readIssueStatus(source: Source, externalId: string): Promise<IssueStatus>;
}

/** ADR-0068: creates a "relates to" link between two issues of the same tracker instance. */
export interface IssueLinker {
  linkIssues(source: Source, fromExternalId: string, toExternalId: string): Promise<void>;
}

export const canReadIssueStatus = (c: SourceConnector): c is SourceConnector & IssueStatusReader =>
  typeof (c as Partial<IssueStatusReader>).readIssueStatus === "function";
export const canLinkIssues = (c: SourceConnector): c is SourceConnector & IssueLinker =>
  typeof (c as Partial<IssueLinker>).linkIssues === "function";

/** ADR-0066 §6: lets the syncer skip an issue whose mirror proposal is not linked to its work item yet. */
export interface MirrorLinkChecker {
  isUnlinkedMirror(description: string | undefined): Promise<boolean>;
}

export interface FollowUpOrigin {
  originWorkItemRef: { name: string };
  originSnapshot: NonNullable<import("../model/kinds.ts").WorkItem["spec"]["originSnapshot"]>;
}

/** ADR-0068 §5: lets the syncer attach the origin to a ticket the factory created from a follow-up. */
export interface FollowUpOriginResolver {
  resolve(description: string | undefined): Promise<FollowUpOrigin | null>;
}
