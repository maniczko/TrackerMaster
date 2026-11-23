#!/usr/bin/env node
/**
 * Read-only governance audit of exported Notion task rows and GitHub PR/CI JSON.
 * Does not contact services, edit records, merge PRs or mark QA as PASS.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACTIVE_STATUSES = new Set(['W realizacji', 'Do weryfikacji', 'Zablokowane']);
const KNOWN_STATUSES = new Set(['Do decyzji', 'Do analizy', 'Gotowe do realizacji', 'W realizacji', 'Do weryfikacji', 'Zablokowane', 'Zrobione']);
const REQUIRED_JOBS = ['build', 'windows-application', 'msix-lifecycle'];

function value(record, ...names) {
  for (const name of names) {
    if (record && typeof record[name] === 'string') return record[name].trim();
  }
  return '';
}

function prNumber(text) {
  const m = /\bPR\s*#(\d+)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

function headSha(pr) {
  return value(pr, 'head_sha') || value(pr?.head, 'sha');
}

function baseBranch(pr) {
  return value(pr, 'base_branch', 'base') || value(pr?.base, 'ref');
}

function issue(severity, code, subject, detail) {
  return { severity, code, subject, detail };
}

export function auditSnapshot({ tasks, pullRequests, workflowRuns } = {}) {
  if (!Array.isArray(tasks) || !Array.isArray(pullRequests)) {
    throw new Error('tasks and pullRequests must be JSON arrays.');
  }
  if (workflowRuns !== undefined && !Array.isArray(workflowRuns)) {
    throw new Error('workflowRuns must be a JSON array when provided.');
  }
  const issues = [];
  const prs = new Map(pullRequests.map(pr => [Number(pr.number), pr]));
  const taskIds = new Set();

  for (const task of tasks) {
    const id = value(task, 'userDefined:ID', 'id', 'ID');
    const status = value(task, 'Status', 'status');
    const owner = value(task, 'Agent prowadzący', 'owner', 'agent');
    const reviewer = value(task, 'Recenzent', 'reviewer');
    const blocker = value(task, 'Bloker', 'blocker');
    const evidence = value(task, 'Dowody', 'evidence');
    const subject = id || '(missing task ID)';

    if (!id) issues.push(issue('error', 'TASK_ID_MISSING', subject, 'Task lacks a stable ID.'));
    else if (taskIds.has(id)) issues.push(issue('error', 'TASK_ID_DUPLICATED', subject, 'Duplicate task ID in the supplied export.'));
    taskIds.add(id);
    if (!KNOWN_STATUSES.has(status)) {
      issues.push(issue('error', 'STATUS_UNKNOWN', subject, 'Unknown or missing status: ' + status));
    }
    if (ACTIVE_STATUSES.has(status) && !owner) {
      issues.push(issue('warning', 'OWNER_MISSING', subject, 'Active/blocked task has no named responsible owner.'));
    }
    if ((status === 'Do weryfikacji' || status === 'Zrobione') && !reviewer) {
      issues.push(issue('warning', 'REVIEWER_MISSING', subject, 'Reviewer field is blank; verify historical review before naming anyone.'));
    }
    if (status === 'Zablokowane' && !blocker) {
      issues.push(issue('error', 'BLOCKER_MISSING', subject, 'Blocked task has no concrete blocker.'));
    }
    if ((status === 'Zrobione' || status === 'Do weryfikacji') && !evidence) {
      issues.push(issue('error', 'EVIDENCE_MISSING', subject, 'No evidence is recorded for verification/completion.'));
    }
    if (status === 'Zablokowane' && !evidence) {
      issues.push(issue('warning', 'BLOCKER_EVIDENCE_MISSING', subject, 'Blocked task lacks evidence: record reason and next executable step.'));
    }

    const mentionedPr = prNumber(blocker);
    if (mentionedPr !== null && prs.has(mentionedPr)) {
      const pr = prs.get(mentionedPr);
      const historicalNote = /histor(?:yczn|ic)|zamkni(?:ę|e)t|closed|nieaktywn/i.test(blocker);
      if (pr.state === 'closed' && !historicalNote) {
        issues.push(issue('warning', 'CLOSED_PR_IN_BLOCKER', subject, 'Blocker references closed PR #' + mentionedPr + ' without marking it as historical.'));
      }
    }
    // This is a review prompt, not proof that "Zrobione" is incorrect.
    if (status === 'Zrobione') {
      const mentioned = prNumber(evidence);
      if (mentioned !== null) {
        const pr = prs.get(mentioned);
        if (pr && pr.state === 'open' && pr.draft) {
          issues.push(issue('warning', 'DONE_CITES_DRAFT_PR', subject, 'Completion evidence mentions draft PR #' + mentioned + '; verify merged or independent evidence.'));
        }
      }
    }
  }

  for (const pr of pullRequests) {
    if (pr.state !== 'open') continue;
    const sha = headSha(pr);
    const subject = 'PR #' + String(pr.number);
    if (!/^[a-f0-9]{40}$/i.test(sha)) {
      issues.push(issue('error', 'PR_HEAD_MISSING', subject, 'PR has no full commit SHA.'));
      continue;
    }
    if (workflowRuns === undefined) {
      issues.push(issue('info', 'CI_DATA_NOT_PROVIDED', subject, 'Supply workflowRuns to verify exact HEAD CI.'));
    } else {
      const matching = workflowRuns.filter(run => value(run, 'head_sha') === sha);
      if (matching.length === 0) {
        issues.push(issue('warning', 'CI_NOT_FOUND_FOR_HEAD', subject, 'No workflow run in supplied snapshot for HEAD ' + sha + '.'));
      } else {
        const passed = matching.some(run => {
          if (run.status !== 'completed' || run.conclusion !== 'success') return false;
          if (!Array.isArray(run.jobs)) return true; // Workflow success, but per-job proof not supplied.
          const byName = new Map(run.jobs.map(job => [job.name, job.conclusion]));
          return REQUIRED_JOBS.every(name => byName.get(name) === 'success');
        });
        if (!passed) {
          issues.push(issue('warning', 'CI_NOT_PASS_FOR_HEAD', subject, 'No completed successful run covering required jobs at HEAD ' + sha + '.'));
        } else if (matching.some(run => run.status === 'completed' && run.conclusion === 'success' && !Array.isArray(run.jobs))) {
          issues.push(issue('info', 'CI_JOB_DETAILS_NOT_PROVIDED', subject, 'Workflow passed for exact HEAD; verify required job logs separately.'));
        }
      }
    }
    const base = baseBranch(pr);
    if (base && base !== 'main') {
      issues.push(issue('info', 'STACKED_PR', subject, 'Targets branch ' + base + '; verify merge sequence before updating main.'));
    }
  }

  const count = severity => issues.filter(i => i.severity === severity).length;
  return {
    summary: { tasks: tasks.length, pullRequests: pullRequests.length, errors: count('error'), warnings: count('warning'), information: count('info') },
    issues
  };
}

function argument(args, flag) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

function main(args) {
  const notionPath = argument(args, '--notion');
  const githubPath = argument(args, '--github');
  if (!notionPath || !githubPath) {
    process.stderr.write('Usage: node scripts/governance-audit.mjs --notion notion.json --github github.json [--strict]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const notion = JSON.parse(readFileSync(notionPath, 'utf8'));
    const github = JSON.parse(readFileSync(githubPath, 'utf8'));
    const tasks = Array.isArray(notion) ? notion : (notion.tasks ?? notion.results);
    const pullRequests = Array.isArray(github) ? github : (github.pullRequests ?? github.pull_requests ?? github.pulls);
    const workflowRuns = Array.isArray(github) ? undefined : (github.workflowRuns ?? github.workflow_runs);
    const result = auditSnapshot({ tasks, pullRequests, workflowRuns });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (args.includes('--strict') && result.summary.errors) process.exitCode = 1;
  } catch (error) {
    process.stderr.write('Governance audit failed: ' + error.message + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
