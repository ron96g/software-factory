import type { CommitMessageConvention } from "../ports/index.ts";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().replace(/\.$/, "");

/** The message without a declared convention (ADR-0023). */
export const plainCommitMessage = (input: { title: string; workItem: string }) => `${oneLine(input.title)}\n\nWork item: ${input.workItem}`;

/** Conventional types a classification maps to; anything else is a feature. */
const TYPES: Record<string, string> = { bug: "fix", fix: "fix", defect: "fix", docs: "docs", documentation: "docs", chore: "chore", refactor: "refactor", test: "test" };

/** A title that already starts with a Conventional Commits type (the conventional-pre-commit default set). */
const PREFIXED = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?!?: \S/;

/** ADR-0092: Conventional Commits (`<type>: <description>`), e.g. for repositories that run `conventional-pre-commit`. */
export const conventionalCommits: CommitMessageConvention = {
  type: "conventional",
  format({ title, workItem, classification }) {
    const type = TYPES[classification?.toLowerCase() ?? ""] ?? "feat";
    // A title that already carries a conventional prefix keeps it.
    const description = oneLine(title);
    const header = PREFIXED.test(description) ? description : `${type}: ${description}`;
    return `${header}\n\nWork item: ${workItem}`;
  },
};
