import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSnapshot } from '../scripts/governance-audit.mjs';

const head = 'a'.repeat(40);
const openPr = { number: 63, state: 'open', draft: true, head: { sha: head }, base: { ref: 'main' } };
const resultCodes = result => result.issues.map(i => i.code);

test('missing independent reviewer is flagged, not silently filled', () => {
  const result = auditSnapshot({ tasks: [{ id: 'DEV-05', status: 'Do weryfikacji', evidence: 'CI log', owner: 'Developer' }], pullRequests: [] });
  assert.ok(resultCodes(result).includes('REVIEWER_MISSING'));
  assert.equal(result.summary.errors, 0);
});

test('blocked task with missing owner, blocker and evidence is reported', () => {
  const result = auditSnapshot({ tasks: [{ id: 'QA-01', status: 'Zablokowane' }], pullRequests: [] });
  assert.ok(resultCodes(result).includes('OWNER_MISSING'));
  assert.ok(resultCodes(result).includes('BLOCKER_MISSING'));
  assert.ok(resultCodes(result).includes('BLOCKER_EVIDENCE_MISSING'));
});

test('closed PR in active blocker is a warning, historical note is not', () => {
  const prs = [{ number: 8, state: 'closed', draft: true }];
  const active = auditSnapshot({ tasks: [{ id: 'DEV-09', status: 'W realizacji', owner: 'agent', blocker: 'Otwarty PR #8' }], pullRequests: prs });
  const historical = auditSnapshot({ tasks: [{ id: 'DEV-09', status: 'W realizacji', owner: 'agent', blocker: 'Historyczny PR #8 zamknięty.' }], pullRequests: prs });
  assert.ok(resultCodes(active).includes('CLOSED_PR_IN_BLOCKER'));
  assert.ok(!resultCodes(historical).includes('CLOSED_PR_IN_BLOCKER'));
});

test('only exact HEAD workflow success counts as passing CI', () => {
  const pr = [openPr];
  const obsolete = auditSnapshot({ tasks: [], pullRequests: pr, workflowRuns: [{ head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success' }] });
  assert.ok(resultCodes(obsolete).includes('CI_NOT_FOUND_FOR_HEAD'));
  const passed = auditSnapshot({
    tasks: [], pullRequests: pr,
    workflowRuns: [{ head_sha: head, status: 'completed', conclusion: 'success',
      jobs: ['build','windows-application','msix-lifecycle'].map(name => ({ name, conclusion: 'success' })) }]
  });
  assert.ok(!resultCodes(passed).includes('CI_NOT_PASS_FOR_HEAD'));
  assert.ok(!resultCodes(passed).includes('CI_NOT_FOUND_FOR_HEAD'));
});

test('workflow success without job details is not claimed as full job evidence', () => {
  const result = auditSnapshot({ tasks: [], pullRequests: [openPr], workflowRuns: [{ head_sha: head, status: 'completed', conclusion: 'success' }] });
  assert.ok(resultCodes(result).includes('CI_JOB_DETAILS_NOT_PROVIDED'));
});

test('stacked PR is identified without automatically calling it a defect', () => {
  const result = auditSnapshot({ tasks: [], pullRequests: [{ ...openPr, base: { ref: 'feat/calendar-week' } }], workflowRuns: [] });
  assert.ok(result.issues.some(i => i.code === 'STACKED_PR' && i.severity === 'info'));
});

test('done task with only draft PR cited triggers investigation, not automatic status change', () => {
  const result = auditSnapshot({
    tasks: [{ id: 'DEV-31', status: 'Zrobione', evidence: 'PR #63 passes CI', reviewer: 'Reviewer' }],
    pullRequests: [openPr]
  });
  assert.ok(resultCodes(result).includes('DONE_CITES_DRAFT_PR'));
});

test('duplicate task IDs and malformed input are explicit errors', () => {
  const tasks = [{ id: 'DEV-01', status: 'W realizacji', owner: 'agent' }, { id: 'DEV-01', status: 'W realizacji', owner: 'agent' }];
  const result = auditSnapshot({ tasks, pullRequests: [] });
  assert.ok(resultCodes(result).includes('TASK_ID_DUPLICATED'));
  assert.throws(() => auditSnapshot({ tasks: 'wrong', pullRequests: [] }), /arrays/);
});
