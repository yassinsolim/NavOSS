import { createHash } from 'node:crypto';

const contributionTypes = new Set([
  'missing-place',
  'place-correction',
  'road-change',
  'route-issue',
]);
const priorities = new Set(['low', 'medium', 'high', 'critical']);
const approvedKeys = new Set(['key', 'priority', 'receivedDate', 'safeContext', 'summary', 'type']);
const obviousPrivatePattern =
  /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:\+?1[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}\b|\b-?\d{1,3}\.\d{4,}(?:\s*[,/]\s*|\s+)-?\d{1,3}\.\d{4,}\b/iu;
const decimalCoordinatePattern = /[-+]?\d{1,3}(?:[.,]\d{4,}).{0,24}[-+]?\d{1,3}(?:[.,]\d{4,})/u;
const degreesMinutesSecondsPattern =
  /\d{1,3}\s*°\s*\d{1,2}(?:[.,]\d+)?\s*[′'](?:\s*\d{1,2}(?:[.,]\d+)?\s*[″"])?\s*[NSEW]?.{0,24}\d{1,3}\s*°/iu;
const approvedInstructions =
  'Human-redacted, deidentified beta feedback approved for AI-assisted engineering triage.';

function normalized(value) {
  return value
    .toLocaleLowerCase('en-CA')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokenOverlap(left, right) {
  const words = (value) =>
    new Set(
      normalized(value)
        .split(' ')
        .filter((token) => token.length > 2),
    );
  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let shared = 0;
  for (const token of leftWords) if (rightWords.has(token)) shared += 1;
  return shared / Math.min(leftWords.size, rightWords.size);
}

function containsObviousPrivateData(text) {
  return (
    obviousPrivatePattern.test(text) ||
    decimalCoordinatePattern.test(text) ||
    degreesMinutesSecondsPattern.test(text)
  );
}

function assertDeidentified(value, raw, field, maximumLength) {
  const text = value?.trim();
  if (text === undefined || text.length === 0) return undefined;
  if (text.length > maximumLength) throw new Error(`${field} is too long.`);
  if (containsObviousPrivateData(text)) {
    throw new Error(`${field} contains an email, phone number, or precise coordinate.`);
  }
  const normalizedText = normalized(text);
  const normalizedDescription = normalized(raw.description);
  if (
    normalizedText === normalizedDescription ||
    (normalizedText.length >= 12 && normalizedDescription.includes(normalizedText)) ||
    tokenOverlap(text, raw.description) >= 0.7
  ) {
    throw new Error(`${field} is too similar to the raw description.`);
  }
  if (typeof raw.locationLabel === 'string') {
    const normalizedLocation = normalized(raw.locationLabel);
    if (normalizedLocation.length >= 4 && normalizedText.includes(normalizedLocation)) {
      throw new Error(`${field} contains the raw location label.`);
    }
  }
  return text;
}

export function psqlScalar(output) {
  const values = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(?:UPDATE|DELETE|INSERT) \d+$/u.test(line));
  if (values.length !== 1) throw new Error('PostgreSQL did not return one scalar value.');
  return values[0];
}

export function feedbackKey(reviewId) {
  if (!/^[0-9a-f-]{36}$/u.test(reviewId)) throw new Error('Feedback row has an invalid ID.');
  return `feedback-${createHash('sha256').update(reviewId).digest('hex').slice(0, 20)}`;
}

export function validateRawFeedback(item) {
  if (
    typeof item !== 'object' ||
    item === null ||
    typeof item.reviewId !== 'string' ||
    !contributionTypes.has(item.type) ||
    typeof item.description !== 'string' ||
    typeof item.receivedAt !== 'string'
  ) {
    throw new Error('The private feedback stream has an invalid row.');
  }
  feedbackKey(item.reviewId);
  return item;
}

export function approvedFeedbackItem(item, answers) {
  validateRawFeedback(item);
  const summary = assertDeidentified(answers.summary, item, 'Summary', 500);
  const safeContext = assertDeidentified(answers.safeContext, item, 'Safe context', 200);
  if (summary === undefined || summary.length < 3) {
    throw new Error('A manually redacted summary between 3 and 500 characters is required.');
  }
  if (!priorities.has(answers.priority)) {
    throw new Error('Priority must be low, medium, high, or critical.');
  }
  return {
    key: feedbackKey(item.reviewId),
    priority: answers.priority,
    receivedDate: item.receivedAt.slice(0, 10),
    ...(safeContext === undefined ? {} : { safeContext }),
    summary,
    type: item.type,
  };
}

export function validateApprovedFeedbackItem(item) {
  if (
    typeof item !== 'object' ||
    item === null ||
    Object.keys(item).some((key) => !approvedKeys.has(key)) ||
    !/^feedback-[0-9a-f]{20}$/u.test(item.key) ||
    !priorities.has(item.priority) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(item.receivedDate) ||
    typeof item.summary !== 'string' ||
    item.summary.length < 3 ||
    item.summary.length > 500 ||
    !contributionTypes.has(item.type) ||
    (item.safeContext !== undefined &&
      (typeof item.safeContext !== 'string' || item.safeContext.length > 200))
  ) {
    throw new Error('The approved feedback inbox has an invalid item.');
  }
  if (
    containsObviousPrivateData(item.summary) ||
    containsObviousPrivateData(item.safeContext ?? '')
  ) {
    throw new Error('The approved feedback inbox contains obvious personal data.');
  }
  return item;
}

export function validateApprovedFeedbackDocument(document) {
  if (
    typeof document !== 'object' ||
    document === null ||
    Object.keys(document).some(
      (key) => !['generatedAt', 'instructions', 'items', 'schemaVersion'].includes(key),
    ) ||
    document.schemaVersion !== 1 ||
    typeof document.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(document.generatedAt)) ||
    document.instructions !== approvedInstructions ||
    !Array.isArray(document.items)
  ) {
    throw new Error('The approved feedback inbox has an invalid document.');
  }
  return document.items.map(validateApprovedFeedbackItem);
}

export function approvedFeedbackDocument(items, generatedAt = new Date().toISOString()) {
  const byKey = new Map(
    items.map((item) => {
      const validated = validateApprovedFeedbackItem(item);
      return [validated.key, validated];
    }),
  );
  return {
    generatedAt,
    instructions: approvedInstructions,
    items: [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key, 'en-CA')),
    schemaVersion: 1,
  };
}
