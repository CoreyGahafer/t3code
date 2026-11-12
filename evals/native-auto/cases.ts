export const cases = [
  {
    id: "queue-pin",
    source: "Synthetic reproduction of the saved-route regression fixed in fork PR #1",
    prompt:
      "Fix selectionForQueue so an already resolved Auto run keeps its saved model and effort. Ordinary runs still inherit the queue tail. Return the complete corrected source.mjs.",
    sourceCode: `export function selectionForQueue(run, tail) {
  return tail?.modelSelection ?? run.modelSelection;
}\n`,
    testCode: `import { strict as assert } from 'node:assert';
import { selectionForQueue } from './source.mjs';
const saved = {model:'sol', effort:'low'};
const tail = {modelSelection:{model:'astra', effort:'medium'}};
assert.deepEqual(selectionForQueue({autoRoute:true, modelSelection:saved}, tail), saved);
assert.deepEqual(selectionForQueue({modelSelection:saved}, tail), tail.modelSelection);
assert.deepEqual(selectionForQueue({modelSelection:saved}, null), saved);\n`,
    solution: `export function selectionForQueue(run, tail) {
  return run.autoRoute ? run.modelSelection : tail?.modelSelection ?? run.modelSelection;
}\n`,
    route: "implementation",
    rubric:
      "Preserves the complete saved selection for Auto, ordinary queue inheritance, and no-tail fallback.",
  },
  {
    id: "inflight-budget",
    source: "Synthetic control derived from native Auto evaluation reservation semantics",
    prompt:
      "Fix committedSpend so unresolved reservations count at their maximum and a reconciled zero counts as zero. Return the complete corrected source.mjs.",
    sourceCode: `export function committedSpend(rows) {
  return rows.reduce((sum, row) => sum + (row.actual || 0), 0);
}\n`,
    testCode: `import { strict as assert } from 'node:assert';
import { committedSpend } from './source.mjs';
assert.equal(committedSpend([{maximum:15, actual:null},{maximum:10, actual:0},{maximum:5, actual:2}]),17);
assert.equal(committedSpend([]),0);\n`,
    solution: `export function committedSpend(rows) {
  return rows.reduce((sum, row) => sum + (row.actual ?? row.maximum), 0);
}\n`,
    route: "mechanical",
    rubric: "Counts in-flight maximums, preserves actual zero, and sums reconciled costs.",
  },
  {
    id: "followup",
    source: "Control for context-dependent follow-ups in the agreed router design",
    history: [
      {
        role: "user" as const,
        text: "How should saved Auto routes survive a server restart?",
        attachmentCount: 0,
      },
      {
        role: "assistant" as const,
        text: "Persist the concrete model and effort before provider work. A restart continuation must reuse that route and never classify the same user turn again.",
        attachmentCount: 0,
      },
    ],
    prompt:
      "Review that plan for failures during commit, provider startup, and restart. Explain the invariants and focused tests.",
    route: "baseline",
    rubric:
      "Distinguishes precommit failure, ambiguous provider dispatch, and durable continuation; avoids blind replay and reclassification.",
  },
  {
    id: "architecture",
    source: "Control for high-risk repository architecture decisions",
    prompt:
      "Our event-sourced coding server commits commands, events and outbox effects atomically, then launches providers. Explain where per-user-turn model routing belongs and how queue promotion, explicit manual pins, child delegation, cancellation and restart affect it.",
    route: "baseline",
    rubric:
      "Routes before provider work, persists concrete selection, reuses it for continuations, preserves manual pins, and excludes child classification. Explicitly addresses ambiguous dispatch.",
  },
  {
    id: "rename",
    source: "Mechanical edit control",
    prompt:
      "Rename the exported constant MAX_SIZE to MAX_BYTES. Return the complete corrected source.mjs.",
    sourceCode: "export const MAX_SIZE = 4096;\n",
    testCode:
      "import { strict as assert } from 'node:assert';\nimport * as source from './source.mjs';\nassert.equal(source.MAX_BYTES,4096);\nassert.equal('MAX_SIZE' in source,false);\n",
    solution: "export const MAX_BYTES = 4096;\n",
    route: "mechanical",
    rubric: "Exports MAX_BYTES with the original value and removes MAX_SIZE.",
  },
] as const;
