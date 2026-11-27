---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: pull-request-review
spec:
  description: Turn a code review of an external pull request into a clear verdict (accepted, partially accepted, rejected).
---

# Pull Request Review

The change is the pull request's diff; its description is the spec. There is no approved plan.

0. **Read the change yourself (ADR-0095).** Your context has a *change manifest*: every changed file with its size and
   review scope, grouped by module, but no patch. Generated files are already out of scope. Work module by module:
   read the module's files together with `read_change({ paths: [...] })` (continue where it says), check surrounding
   code with `read_file`/`search_code`, then acknowledge them together with `acknowledge_change({ files: [...] })`
   (`reviewed`, or `skipped` with a reason). Only write findings about files you reviewed. Read every file you can: each
   result tells you the steps left, and `budget-exhausted` is accepted only in the last 3 steps. Then acknowledge the
   rest as `budget-exhausted`, say so in `rationale`, and do not choose `accepted`.

1. Review only what the diff changes, plus code it breaks. Pre-existing problems are at most `non-blocking`.
2. **Line references** become inline comments on the pull request, combined with the verdict into one review:
   - `line` (and `startLine` for a range) must be an added or context line of a changed hunk in the head version.
     For a deleted line use `side: LEFT` with the base version's line number.
   - A finding about a whole file or about code the diff doesn't touch has **no** `line`; name the place in `message`.
   - `suggestion` (optional): the replacement code for exactly the commented lines, only when the fix is local and
     certain. GitHub shows it with an "Apply suggestion" button.
3. **Verdict** (also your `outcome`), decided by the findings:
   - `accepted`: no blocking finding; mergeable as it is. `requiredChanges` is empty; non-blocking notes are optional.
   - `partially-accepted`: the approach and most of the change are sound, but specific, bounded changes are required
     before merging. List what is fine in `accepted` and each required change in `requiredChanges`.
   - `rejected`: the change is wrong in approach, unsafe, or would need rework rather than fixes. List in
     `requiredChanges` what a new attempt must do differently.
   If you could not verify something important, say so in `rationale` and do not choose `accepted`.
4. `summary`: what the change does, in one or two sentences. `rationale`: why this verdict, referring to the findings.
   Each `requiredChanges` entry is actionable: what, where, how to verify.
5. A human decides and may override the verdict; never claim the change is approved.
