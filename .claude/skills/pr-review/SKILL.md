---
name: pr-review
description: Use when asked to review a GitHub pull request on AgentDock by number or URL, including a re-review after new commits. Reads state, CI and the stacked base with gh, checks the diff against the repo rules, and drafts comments that are posted only after the developer says yes. Never approves or merges.
argument-hint: <pr-number or URL>
---

# Review a pull request

Read-only until the developer says yes. Never approve, request changes, merge, push, or edit the PR, its branch or its labels.

## 1. Intake

```bash
gh pr view <n> --json number,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,author,url
gh pr checks <n>
gh pr view <n> --comments
gh api repos/{owner}/{repo}/pulls/<n>/comments --jq '.[] | {id, path, line, user: .user.login, body}'
```

Write down:

- **State:** open, draft or closed. A closed PR gets no review unless asked.
- **Base:** `main` or another PR's branch. When the base is not `main`, the PR is stacked: review only what this PR adds over its base, and name the PR below it (`gh pr list --head <base>`).
- **CI on the head commit:** each check and its result. A red check is the first finding; read it with `gh run view <run-id> --log-failed` and the `agentdock-ci` skill.
- **Earlier rounds:** your own past comments and whether the new commits answered them. On a re-review, check each one: fixed, not fixed, or answered with a reason.

## 2. Size the review

```bash
gh pr diff <n> --name-only
gh pr diff <n>
```

- Docs or config only: check facts against code, links and the rules for docs.
- Backend route, security or audit reading: full depth, read the callers and tests too.
- Dashboard page: logic in `frontend/src/lib/events.ts` and its tests, and the `dashboard-ui` rules.

## 3. Check the diff

Use the checklist in the `review` agent (`.claude/agents/review.md`, step 4). Also check:

- **Claims:** every statement in the PR body and in changed docs is true in the code. Open the file and line.
- **Tests:** a bug fix has a `regression:` test. To prove it catches the bug, run that one test with the fix undone. Do it only in a separate checkout, and ask the developer where to make one first; never undo code in the developer's working tree.
- **Scope:** every changed file belongs to the PR's stated purpose. List the ones that do not.
- **Docs:** `README.md`, `ISSUE.md` and `docs/DECISIONS.md` match the change. A new D-number does not clash with another open PR.
- **Template:** each ticked box in the PR body is true.

## 4. Draft the comments

For each finding, draft one comment:

```
<file>:<line>  [Critical | High | Medium | Low]
Problem: <what is wrong, in one or two sentences>
Expected: <what the code should do instead>
```

- Put an inline comment on the line it is about. Put general points in one summary comment.
- Plain words. No praise filler, no "nit:" pile. Merge findings with one root into one comment.

Show the full draft to the developer and ask: post all, post some, or change wording?

## 5. Post only after a yes

- Post exactly what was approved.
- One summary comment per round. To correct it, edit that comment (`gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -f body=...`); do not post a second one.
- Post as a plain comment, never as an approval or a "request changes" review, unless the developer asks for that review type.

## 6. Report

```
PR #<n> <title> (base: <branch>, head: <short sha>)
CI: <green / red: which check>
Findings: <count by severity>
Posted: <yes, with links / no, waiting>
Ready to merge: <yes / no: what blocks it>  (use the merge-readiness skill for the full check)
```
