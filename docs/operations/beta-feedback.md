# Beta feedback review workflow

NavOSS accepts account-free private feedback with no precise coordinate or device identifier. Raw
descriptions may still contain personal information entered by a tester. Raw feedback therefore
stays outside AI context until a human operator manually removes private details and approves a
deidentified engineering summary.

## Current inbox

View aggregate counts only:

```sh
corepack pnpm feedback:counts
```

This command reports counts grouped by workflow state and feedback type without returning
descriptions, labels, timestamps, or identifiers.

## Human review boundary

Run this command yourself in a local terminal, not through an AI chat tool:

```sh
corepack pnpm feedback:redact
```

The workspace `.github/hooks/feedback-privacy.json` PreToolUse hook denies agent attempts to run
this command or query raw contribution columns. Run it from an ordinary terminal you control, not a
terminal tool inside Copilot Chat.

`feedback:redact` streams pending rows from PostgreSQL directly into the interactive terminal and
never writes raw descriptions, labels, or database IDs to disk. It displays one private row at a
time and requires an explicit approve, reject, or skip choice. Approval requires a new human-written
summary, optional public context, and priority. Obvious emails, phone numbers, precise coordinates,
raw location labels, and near-verbatim descriptions fail closed, but the human remains responsible
for removing names, addresses, exact personal trips, credentials, and unnecessary details.

Approved summaries are written to the ignored
`artifacts/feedback/approved/triage-input.json`. Stable workflow keys are one-way hashes of random
database IDs; the IDs themselves are never written to disk.

## AI triage

In VS Code, select **Beta Feedback Triage** as the agent or run `/triage-beta-feedback`. The agent is
restricted to read/search tools and may read only the approved deidentified document. It groups
duplicates, checks nearby code/tests, and drafts issues. It cannot edit code, run commands, create
issues, invoke agents, commit, or deploy.

After reviewing its output, explicitly select one approved key and run
`/implement-approved-feedback feedback-0123456789abcdefabcd`. The repository-owned builder agent may
edit only that selected item. It has no terminal or subagent tools and cannot validate, commit, push,
or deploy; return to the main coding agent for focused validation and any separately authorized
release action.

## Workflow status

After human review or verified implementation, update the server status:

```sh
corepack pnpm feedback:status -- feedback-0123456789abcdefabcd resolved
corepack pnpm feedback:status -- feedback-0123456789abcdefabcd rejected
```

Resolving or rejecting an approved item removes it from the local approved inbox. The production
retention sweep continues deleting server rows after 90 days. Never commit anything under
`artifacts/`.

## Privacy rules

- Never paste raw contribution text into Copilot or another model.
- Remove names, addresses, contact details, exact personal trips, credentials, and unnecessary
  timestamps from approved summaries.
- Keep only public place/road context needed to reproduce the issue.
- NavOSS does not automatically transmit raw submissions to an AI provider. Operator policy requires
  running the interactive redaction command outside an AI conversation; only human-created
  deidentified summaries may be used for AI-assisted engineering triage.
- A proposed issue is not proof. Reproduce and validate behavior before implementation or closure.
