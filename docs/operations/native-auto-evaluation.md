# Native Auto evaluation gate

Native Auto is under development and disabled. `t3-auto` is reserved; it must never
reach Codex as a model. A concrete selection remains the manual recovery path.
No global defaults or installed settings change. No paid evaluation is authorized
by changing a model picker or adding this reserved custom slug.

The selected Codex instance owns two saved flags, `nativeAutoEnabled` and
`nativeAutoApproved`. Both default off. Approval is a deliberate operator action
after evaluation; selecting Auto does not grant evaluation approval. The shared
provider catalog exposes Auto only when both flags are set. Manual selection pins
a concrete model; selecting Auto again restores routing for the next user turn.

Routing resolves the selected instance's existing OpenAI API-key auth.json in its
effective home. Managed ChatGPT, credential-store overrides, custom model providers,
launch overrides, and conflicting environment credentials fail closed. The classifier
posts only to the fixed OpenAI Decisions endpoint with redirects disabled. Its
one-second deadline includes response decoding and closes the request on timeout.

The concrete route is stored on the run before its provider work enters the outbox.
The thread retains picker intent separately. Continuations use that run selection.
Operational records contain policy, concrete profile, latency and fallback only;
usage and cost remain unknown when unavailable. Files expire after 30 days, with
cleanup on routing and hourly while the provider instance is loaded.

## Before spending money

Obtain explicit approval for Astra and the paid pilot. Confirm account availability,
capabilities and current billing for each frozen candidate (Astra medium, Sol 6.1
medium, Sol 6.1 low) and Luna Decisions. These are candidates, not evaluated routes.
The initial ceiling is $25 total. Moving to $100 requires a separate decision.

The SQLite-backed `NativeAutoEvaluationBudget` service enforces the $25 pilot
ceiling. Its atomic reservation returns false for duplicate IDs or insufficient
remaining budget; false means do not dispatch. A future paid evaluation runner
must call it for every billable operation and supply a verified pricing revision.
There is deliberately no paid evaluation runner or approval enabled in this change.
Each request needs
an idempotent reservation for its conservative maximum cost before launch. Count
all in-flight reservations against the ceiling. Reconcile actual usage afterward;
missing usage or ambiguous completion retains the reservation. Include classifier,
inference, retries, corrective work, tools and optional judge costs. Reject unknown
pricing, tiers and billing features. Do not refund on timeout alone.

Select evaluation cases deliberately and store them separately from operational
logs in private local storage, with an approved capture scope and deletion date.
Use fixed repository revisions and isolated checkouts for edits. Include questions,
edits, debugging, review, architecture, difficult lifecycle work and context-dependent
follow-ups. Define expected constraints and objective correctness checks before
execution. Compare whole-task cost and time, including corrections, against fixed
Astra medium. Have the user review a shuffled blinded sample of open-ended answers;
a model judge may assist but cannot decide acceptance alone.

Keep Auto opt-in and defaults unchanged unless correctness, lifecycle and user-reviewed
quality pass. Roughly 20% savings is a target, not evidence or an invented quality
threshold. Insufficient budget or evidence means inconclusive; keep the gate closed.

Protocol reference: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions).
