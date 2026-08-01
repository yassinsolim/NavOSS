#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  approvedFeedbackDocument,
  approvedFeedbackItem,
  feedbackKey,
  psqlScalar,
  validateApprovedFeedbackDocument,
  validateRawFeedback,
} from './feedback-workflow-lib.mjs';

const root = resolve(import.meta.dirname, '..');
const approvedPath = resolve(root, 'artifacts/feedback/approved/triage-input.json');
const lockPath = resolve(root, 'artifacts/feedback/feedback-review.lock');
const host = process.env.NAVOSS_PRODUCTION_SSH ?? 'navoss-prod';
const composeDirectory = '/home/navoss/NavOSS/infra/compose';

function remotePsql(sql) {
  return execFileSync(
    'ssh',
    [
      host,
      `cd ${composeDirectory} && sudo -n docker compose exec -T reports-db psql -U navoss -d navoss -At`,
    ],
    { encoding: 'utf8', input: `${sql}\n`, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

async function restoreApprovedItems(items, existed) {
  if (!existed) {
    await unlink(approvedPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return;
  }
  await atomicWrite(approvedPath, `${JSON.stringify(approvedFeedbackDocument(items), null, 2)}\n`);
}

async function approvedItems() {
  try {
    const parsed = JSON.parse(await readFile(approvedPath, 'utf8'));
    return validateApprovedFeedbackDocument(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function withWorkflowLock(action) {
  await mkdir(dirname(lockPath), { recursive: true });
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Another feedback workflow is already running.');
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

function counts() {
  const output = remotePsql(
    'SELECT status, type, count(*) FROM contribution_submissions GROUP BY status, type ORDER BY status, type;',
  ).trim();
  console.log(output.length === 0 ? 'No accepted beta feedback.' : output);
}

function updateStatus(reviewId, expectedStatus, status) {
  const result = psqlScalar(
    remotePsql(
      `UPDATE contribution_submissions SET status = '${status}' WHERE id = '${reviewId}' AND status = '${expectedStatus}' RETURNING status;`,
    ),
  );
  if (result !== status) {
    throw new Error(`The feedback was no longer ${expectedStatus}; no transition was applied.`);
  }
}

async function redact() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Redaction requires a human-operated interactive terminal.');
  }
  await withWorkflowLock(async () => {
    const rows = remotePsql(`
      SELECT json_build_object(
        'description', description,
        'locationLabel', location_label,
        'receivedAt', received_at,
        'reviewId', id,
        'type', type
      )
      FROM contribution_submissions
      WHERE status = 'pending'
      ORDER BY received_at, id;
    `)
      .split('\n')
      .filter(Boolean)
      .map((line) => validateRawFeedback(JSON.parse(line)));
    if (rows.length === 0) {
      console.log('No pending feedback is available for redaction.');
      return;
    }

    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const items = await approvedItems();
    try {
      for (const row of rows) {
        console.log('\n--- PRIVATE OPERATOR VIEW; DO NOT COPY VERBATIM ---');
        console.log(`Type: ${row.type}`);
        console.log(`Received: ${row.receivedAt}`);
        console.log(`Location label: ${row.locationLabel ?? '(none)'}`);
        console.log(`Description: ${row.description}`);
        const choice = (await terminal.question('[a]pprove summary, [r]eject, [s]kip: '))
          .trim()
          .toLocaleLowerCase('en-CA');
        if (choice === 'r' || choice === 'reject') {
          updateStatus(row.reviewId, 'pending', 'rejected');
          continue;
        }
        if (choice !== 'a' && choice !== 'approve') continue;
        const summary = await terminal.question('Manually redacted summary: ');
        const safeContext = await terminal.question('Optional public/safe context: ');
        const priority = (await terminal.question('Priority [low/medium/high/critical]: '))
          .trim()
          .toLocaleLowerCase('en-CA');
        const previous = [...items];
        const existed = previous.length > 0;
        items.push(approvedFeedbackItem(row, { priority, safeContext, summary }));
        const document = approvedFeedbackDocument(items);
        await atomicWrite(approvedPath, `${JSON.stringify(document, null, 2)}\n`);
        try {
          updateStatus(row.reviewId, 'pending', 'reviewed');
        } catch (error) {
          items.splice(0, items.length, ...previous);
          await restoreApprovedItems(previous, existed);
          throw error;
        }
      }
    } finally {
      terminal.close();
    }

    const document = approvedFeedbackDocument(items);
    console.log(`Approved inbox now contains ${String(document.items.length)} deidentified items.`);
    console.log(`AI triage may read only ${approvedPath}. No raw export was written.`);
  });
}

async function setStatus(key, status) {
  if (!['resolved', 'rejected'].includes(status)) {
    throw new Error('Status must be resolved or rejected.');
  }
  await withWorkflowLock(async () => {
    const candidates = remotePsql(
      "SELECT id FROM contribution_submissions WHERE status = 'reviewed' ORDER BY id;",
    )
      .split('\n')
      .filter(Boolean);
    const reviewId = candidates.find((candidate) => feedbackKey(candidate) === key);
    if (reviewId === undefined) throw new Error(`No reviewed feedback exists for ${key}.`);
    const previous = await approvedItems();
    const remaining = previous.filter((item) => item.key !== key);
    await atomicWrite(
      approvedPath,
      `${JSON.stringify(approvedFeedbackDocument(remaining), null, 2)}\n`,
    );
    try {
      updateStatus(reviewId, 'reviewed', status);
    } catch (error) {
      await atomicWrite(
        approvedPath,
        `${JSON.stringify(approvedFeedbackDocument(previous), null, 2)}\n`,
      );
      throw error;
    }
    console.log(`${key} is now ${status}.`);
  });
}

const [command, first, second] = process.argv.slice(2);
try {
  if (command === 'counts') counts();
  else if (command === 'redact') await redact();
  else if (command === 'status' && first !== undefined && second !== undefined) {
    await setStatus(first, second);
  } else {
    console.error(
      'Usage: feedback-review.mjs counts|redact|status <feedback-key> resolved|rejected',
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Feedback workflow failed.');
  process.exitCode = 1;
}
