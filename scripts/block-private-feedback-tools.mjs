#!/usr/bin/env node

import { blockedFeedbackToolReason } from './feedback-agent-guard-lib.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  input = {};
}
const reason = blockedFeedbackToolReason(input);
if (reason !== undefined) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}
