---
name: merge-readiness
description: Use when asked whether an AgentDock PR is ready to merge. Report-only check of CI on the head commit, conflicts with main now and for every stacked PR above it, D- and I-number clashes across open PRs, and the merge method to use. Never merges.
argument-hint: <pr-number or URL>
---

# Is this PR ready to merge?

Report only. Never merge, enable auto-merge, push, rebase, retarget, or edit a PR. Every fix is a proposal that waits for the developer's yes.

Each check ends in one of: `OK`, `WARN` (merge is possible but something needs a look) or `BLOCK` (do not merge yet).

## 1. Facts

```bash
git fetch origin --prune
gh pr view <n> --json number,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision
gh pr list --state open --json number,title,baseRefName,headRefName
```

- Draft or closed: `BLOCK`.
- `mergeStateStatus` of `UNKNOWN` means GitHub is still computing; read it again after a few seconds.
- Local `origin/<head>` must equal `headRefOid`. If not, fetch again before going on.

## 2. CI on the head commit

```bash
gh pr checks <n>
gh api repos/{owner}/{repo}/commits/<headRefOid>/check-runs --jq '.check_runs[] | [.name, .status, .conclusion] | @tsv'
```

- Every check finished and passed on `headRefOid`, not on an older commit: `OK`.
- A check still running: `WARN`, wait. A failed check: `BLOCK`; name it and point at the `agentdock-ci` skill.
- A required review missing, or approved on an older commit when the repo dismisses stale approvals: `BLOCK`.

## 3. Conflicts with the base now

`git merge-tree` tries the merge without touching any branch or the working tree:

```bash
git merge-tree --write-tree origin/<base> origin/<head>; echo "rc=$?"
```

`rc=0` is a clean merge. `rc=1` prints the conflicting files: `BLOCK`, and list them.

## 4. Conflicts for every PR stacked above it

Find the stack: open PRs whose base is this PR's head branch, then PRs based on those, and so on.

For each one, simulate this PR merged into its base, then merge the upper PR on top:

```bash
tree=$(git merge-tree --write-tree origin/<base> origin/<head> | head -1)
sim=$(git commit-tree "$tree" -p origin/<base> -p origin/<head> -m "simulated merge")
git merge-tree --write-tree "$sim" origin/<upper-head>; echo "rc=$?"
```

`commit-tree` makes a loose commit object only; it moves no branch. For the next PR up, repeat with `sim` as the new base. A conflict is `WARN` for this PR and names the upper PR and file.

## 5. Number clashes in DECISIONS and ISSUE

`docs/DECISIONS.md` (D-numbers) and `ISSUE.md` (I-numbers) are numbered by hand, so two open PRs can take the same number.

```bash
for b in <head of every open PR>; do
  echo "== $b"; git diff origin/main...origin/$b -- docs/DECISIONS.md ISSUE.md | grep -E '^\+## (D|I)-[0-9]+'
done
git show origin/main:docs/DECISIONS.md origin/main:ISSUE.md | grep -E '^## (D|I)-[0-9]+'
```

- This PR adds a number `main` already has: `BLOCK`.
- Another open PR adds the same number: `WARN`; whichever merges second renumbers. Propose the new number and every line that cites it.

## 6. Merge method

- **PR with other PRs stacked on it: merge commit.** Squash or rebase rewrite this PR's commits into new ones. The upper PRs still carry the old commits, so after this lands they conflict with `main` on every file this PR touched.
- Merge a stack from the bottom up. After each merge, check that the next PR's base moved to `main` before merging it.
- A single PR with nothing above it: a merge commit keeps the repo's history style (`git log --merges --oneline -5` shows it). Squash is fine if the developer prefers it.

## 7. Report

```
PR #<n> <title>  base: <base>  head: <short sha>
Status          OK
CI on head      OK   (9 of 9 passed)
Conflicts now   OK
Stack above     WARN #<m> conflicts in frontend/src/app/styles.css after this merges
Numbers         OK   (adds D-9, I-17; no clash)
Merge method    merge commit (stack above)

Verdict: ready to merge / not ready: <what blocks it>
```

Then list each proposed fix and wait for the developer. The developer merges; you do not.
