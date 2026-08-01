---
name: Implement Approved Feedback
description: 'Implement one explicitly approved beta-feedback item after read-only triage. Requires the user to name the approved feedback key.'
agent: approved-feedback-builder
---

Implement only the approved feedback key explicitly named by the user with this prompt.

- Read that key from `artifacts/feedback/approved/triage-input.json`.
- Never request or consume raw contribution text.
- Verify the report against current code and tests before editing.
- If the key is absent, ambiguous, requests a policy/provider expansion, or is not explicitly named,
  stop and ask for a human decision.
- Follow `AGENTS.md` and add risk-appropriate tests. The main coding agent runs focused validation.
- This builder has no terminal or subagent tools. Return edited files to the main coding agent for
  validation. Do not create a commit, push, deploy, change App Store metadata, or update status.
