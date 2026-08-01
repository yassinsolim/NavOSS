import assert from 'node:assert/strict';
import test from 'node:test';

import { blockedFeedbackToolReason } from './feedback-agent-guard-lib.mjs';

test('blocks raw redaction commands in agent tool input', () => {
  assert.match(
    blockedFeedbackToolReason({ tool_input: { command: 'corepack pnpm feedback:redact' } }),
    /outside an AI session/,
  );
  assert.match(
    blockedFeedbackToolReason({ command: 'node scripts/feedback-review.mjs redact' }),
    /outside an AI session/,
  );
});

test('blocks direct queries for raw contribution columns', () => {
  assert.match(
    blockedFeedbackToolReason({ command: 'SELECT description FROM contribution_submissions' }),
    /aggregate beta-feedback counts/,
  );
  assert.match(
    blockedFeedbackToolReason({ command: 'SELECT * FROM contribution_submissions' }),
    /aggregate beta-feedback counts/,
  );
  assert.match(
    blockedFeedbackToolReason({ command: 'SELECT received_at FROM contribution_submissions' }),
    /aggregate beta-feedback counts/,
  );
});

test('allows only the canonical grouped aggregate and approved inbox reads', () => {
  assert.equal(
    blockedFeedbackToolReason({
      tool_input: {
        command:
          'SELECT status, type, count(*) FROM contribution_submissions GROUP BY status, type ORDER BY status, type;',
      },
    }),
    undefined,
  );
  assert.equal(
    blockedFeedbackToolReason({ filePath: 'artifacts/feedback/approved/triage-input.json' }),
    undefined,
  );
});

for (const query of [
  'SELECT count(*) FROM contribution_submissions',
  'SELECT status, type, count(*) FROM contribution_submissions',
  'SELECT count(*) FROM contribution_submissions GROUP BY status, type',
  'SELECT status, type, count(*) AS total FROM contribution_submissions GROUP BY status, type ORDER BY status, type',
  "SELECT status, type, count(*) FILTER (WHERE status = 'pending') FROM contribution_submissions GROUP BY status, type ORDER BY status, type",
]) {
  test(`blocks noncanonical aggregate: ${query}`, () => {
    assert.match(
      blockedFeedbackToolReason({ tool_input: { command: query }, tool_name: 'run_in_terminal' }),
      /aggregate beta-feedback counts/,
    );
  });
}
