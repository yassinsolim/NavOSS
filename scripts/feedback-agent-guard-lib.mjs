const rawWorkflowPattern = /feedback:redact|feedback-review\.mjs\s+redact/iu;
const rawDatabasePattern = /contribution_submissions/iu;
const safeAggregateQuery =
  'SELECT status,type,count(*) FROM contribution_submissions GROUP BY status,type ORDER BY status,type';

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

function commands(value) {
  if (typeof value !== 'object' || value === null) return [];
  const found = [];
  for (const [key, nested] of Object.entries(value)) {
    if (['command', 'query', 'sql'].includes(key) && typeof nested === 'string') found.push(nested);
    else found.push(...commands(nested));
  }
  return found;
}

function normalizedSql(value) {
  return value
    .replace(/;\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*,\s*/gu, ',')
    .trim();
}

export function blockedFeedbackToolReason(input) {
  const text = strings(input).join('\n');
  if (rawWorkflowPattern.test(text)) {
    return 'Raw beta-feedback redaction must be run by the operator directly in a terminal outside an AI session.';
  }
  const databaseCommands = commands(input).filter((command) => rawDatabasePattern.test(command));
  if (
    databaseCommands.some((command) => normalizedSql(command) !== safeAggregateQuery) ||
    (databaseCommands.length === 0 && rawDatabasePattern.test(text))
  ) {
    return 'AI tools may query only aggregate beta-feedback counts, never raw contribution columns.';
  }
  return undefined;
}
