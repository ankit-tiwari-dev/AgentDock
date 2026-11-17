---
description: Look back at a finished task, find what went wrong or had to be redone, save the lessons to auto-memory, and promote a lesson to the repo once it has repeated three times.
argument-hint: "[task or branch, default: this session]"
---

Run a retrospective on: $ARGUMENTS (this session's task when empty).

## 1. Collect what happened

- `git status`, `git log --oneline main..HEAD` and `git diff --stat main...HEAD`: what changed.
- The conversation: every time the developer corrected you, stopped you, or changed direction, and every step you ran twice.
- The gates: did `make ci` go red, and why.

## 2. Sort the outcome

| Outcome   | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| Clean     | Done right the first time. Write nothing.               |
| Corrected | The developer stepped in to change something.           |
| Redone    | The approach was wrong and part of the work was redone. |

Write lessons only for Corrected and Redone. A lesson for smooth work is noise.

## 3. Write each lesson as a rule

The memory is read months later, on another task, by a session that knows nothing of this one. Write it so it still makes sense then.

1. **Rule:** one imperative sentence, stated generally. "Read the exit code before the output", not "make ci went red on Tuesday".
2. **When it applies:** the kind of situation, without this task's file or function names.
3. **How to apply:** steps someone can check.
4. **Evidence:** one short dated line at the end, naming what happened.

No story, no status, no "first I did X". A lesson that only makes sense to someone who remembers this bug will not help.

## 4. Save to auto-memory

- Save to the developer's auto-memory for this project (the memory folder Claude Code keeps per project, with its index file).
- Search the existing memories first. If the lesson is a new case of a rule already there, add the evidence line to that memory instead of a new one.
- Show the developer each lesson before saving it.

## 5. Promote after three repeats

When the same rule has three evidence lines, it belongs in the repo, where every session sees it. Pick the home by its shape:

| Shape of the lesson                          | Promote to                               |
| -------------------------------------------- | ---------------------------------------- |
| "Always X" or "never Y" for every change     | `CLAUDE.md`, one line                    |
| The detail or reason behind such a rule      | `.claude/docs/rules.md`                  |
| A choice with a rejected alternative         | `docs/DECISIONS.md`, new D-number        |
| A defect with a root cause worth remembering | `ISSUE.md`                               |
| A step a workflow keeps missing              | the agent, command or skill that runs it |

Follow `.claude/docs/rules.md` → "Adding instructions for Claude" for budgets. Propose the exact file, section and text, and write it only after the developer says yes. Then remove the promoted memory, or point it at the new home.

## 6. Report

```
Outcome: Corrected (2 corrections, 1 step redone)
Lessons saved: <name> (new), <name> (evidence added, now 2 of 3)
Promoted: none / <rule> → <file>
```
