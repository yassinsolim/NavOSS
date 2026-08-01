import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvedFeedbackDocument,
  approvedFeedbackItem,
  feedbackKey,
  psqlScalar,
  validateApprovedFeedbackDocument,
} from './feedback-workflow-lib.mjs';

const raw = {
  description: 'Raw private text with an address that must not leave the operator review.',
  locationLabel: 'Private location label',
  receivedAt: '2026-07-31T12:00:00.000Z',
  reviewId: 'fbe6f7cf-8176-499d-8f73-0fcf858d85f0',
  type: 'route-issue',
};

test('approved feedback contains only human-redacted fields', () => {
  const approved = approvedFeedbackItem(raw, {
    priority: 'high',
    safeContext: 'Public downtown intersection',
    summary: 'Route turns late.',
  });
  const serialized = JSON.stringify(approvedFeedbackDocument([approved]));

  assert.equal(approved.key, feedbackKey(raw.reviewId));
  assert.doesNotMatch(serialized, /Raw private text|Private location label|fbe6f7cf/);
  assert.match(serialized, /Route turns late/);
});

test('unchanged raw descriptions cannot be approved', () => {
  assert.throws(
    () => approvedFeedbackItem(raw, { priority: 'medium', summary: `${raw.description}!` }),
    /too similar to the raw description/,
  );
});

test('safe context cannot copy the raw private location label', () => {
  assert.throws(
    () =>
      approvedFeedbackItem(raw, {
        priority: 'medium',
        safeContext: `Near ${raw.locationLabel}`,
        summary: 'Route issue near a public landmark.',
      }),
    /contains the raw location label/,
  );
});

test('obvious personal data is rejected from approved summaries', () => {
  assert.throws(
    () =>
      approvedFeedbackItem(raw, {
        priority: 'medium',
        summary: 'Contact the tester at person@example.com about the route.',
      }),
    /contains an email, phone number, or precise coordinate/,
  );
});

test('stable keys do not expose database identifiers', () => {
  const approved = approvedFeedbackItem(raw, {
    priority: 'medium',
    summary: 'Route issue near a public landmark.',
  });
  const serialized = JSON.stringify(approvedFeedbackDocument([approved, approved]));

  assert.equal(approved.key, feedbackKey(raw.reviewId));
  assert.doesNotMatch(approved.key, /fbe6f7cf/);
  assert.equal(JSON.parse(serialized).items.length, 1);
});

test('null location labels are accepted safely', () => {
  const approved = approvedFeedbackItem(
    { ...raw, locationLabel: null },
    { priority: 'low', summary: 'Missing place near a public park.' },
  );

  assert.equal(approved.key, feedbackKey(raw.reviewId));
});

test('existing approved inbox items reject unexpected private fields', () => {
  assert.throws(
    () =>
      validateApprovedFeedbackDocument({
        generatedAt: '2026-07-31T12:00:00.000Z',
        instructions:
          'Human-redacted, deidentified beta feedback approved for AI-assisted engineering triage.',
        items: [
          {
            ...approvedFeedbackItem(raw, {
              priority: 'low',
              summary: 'Route issue near a public park.',
            }),
            description: raw.description,
          },
        ],
        schemaVersion: 1,
      }),
    /invalid item/,
  );
});

test('whitespace-separated precise coordinates are rejected', () => {
  assert.throws(
    () =>
      approvedFeedbackItem(raw, {
        priority: 'high',
        summary: 'Route failed near 51.0500 -114.0700 during the test.',
      }),
    /contains an email, phone number, or precise coordinate/,
  );
});

for (const coordinate of [
  'lat: 51.0500, lon: -114.0700',
  '51.0500; -114.0700',
  '51.0500° N, 114.0700° W',
  '51,0500 -114,0700',
  '51° 03.000′ N, 114° 04.200′ W',
]) {
  test(`coordinate variant is rejected: ${coordinate}`, () => {
    assert.throws(
      () =>
        approvedFeedbackItem(raw, {
          priority: 'high',
          summary: `Route failed near ${coordinate}.`,
        }),
      /contains an email, phone number, or precise coordinate/,
    );
  });
}

test('existing approved inbox rejects precise coordinate variants', () => {
  const approved = approvedFeedbackItem(raw, {
    priority: 'low',
    summary: 'Route issue near a public park.',
  });
  assert.throws(
    () =>
      validateApprovedFeedbackDocument({
        generatedAt: '2026-07-31T12:00:00.000Z',
        instructions:
          'Human-redacted, deidentified beta feedback approved for AI-assisted engineering triage.',
        items: [{ ...approved, safeContext: '51° 03.000′ N, 114° 04.200′ W' }],
        schemaVersion: 1,
      }),
    /obvious personal data/,
  );
});

test('psql scalar parsing ignores command tags after RETURNING', () => {
  assert.equal(psqlScalar('reviewed\nUPDATE 1\n'), 'reviewed');
  assert.throws(() => psqlScalar('UPDATE 0\n'), /did not return one scalar value/);
});

test('approved document metadata is strict', () => {
  assert.throws(
    () =>
      validateApprovedFeedbackDocument({ generatedAt: 'not-a-date', items: [], schemaVersion: 1 }),
    /invalid document/,
  );
});
