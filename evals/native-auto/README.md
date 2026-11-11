# Native Auto evaluation

Compares the production `classifyAuto` policy with its fixed baseline profile. Each arm gets the same conversation and one Responses API answer. Three executable edit cases run the returned source in separate temporary directories against immutable assertions. Two open-ended cases need human review. Cases are synthetic reproductions and controls with their sources recorded in `cases.ts`; they contain no captured user data.

This is an evaluation harness, not rollout approval. It does not run Codex, exercise tools, edit a real repository checkout, measure corrective agent turns, or establish real-repository quality or savings. Those are required follow-up pilot evidence before enabling Auto. Every summary remains inconclusive, even when all objective checks pass.

## Offline proof

From `evals/`:

```sh
pnpm native-auto --out runs/auto-offline --samples 3
```

Offline is the default, makes no network calls, and uses frozen decisions, answers and synthetic prices. It first verifies that each original source fails its checks, then verifies corrected sources through both arms. Its costs and route choices are fixtures, not model or billing evidence. `--case queue-pin,followup` selects cases. `--out` must be a new directory; rerunning never overwrites evidence.

## Paid pilot preparation

Paid inference and Astra require separate explicit flags. This PR does not authorize running them or alter installed provider settings. Use only the direct API-key configuration; subscription proxies and custom endpoints are unsupported.

Create a private pricing JSON file with this shape, replacing every illustrative value with verified current rates and model capacity bounds:

```json
{
  "revision": "verified-price-source-and-date",
  "models": {
    "gpt-6-luna": {
      "inputMicroUsdPerMillion": 1000000,
      "outputMicroUsdPerMillion": 2000000,
      "maximumInputTokens": 128000,
      "maximumOutputTokens": 32768
    },
    "gpt-6.1-sol": {
      "inputMicroUsdPerMillion": 1000000,
      "outputMicroUsdPerMillion": 2000000,
      "maximumInputTokens": 128000,
      "maximumOutputTokens": 32768
    },
    "gpt-6-astra": {
      "inputMicroUsdPerMillion": 1000000,
      "outputMicroUsdPerMillion": 2000000,
      "maximumInputTokens": 128000,
      "maximumOutputTokens": 32768
    }
  }
}
```

Rates are integer microdollars per million tokens: $1 per million is `1000000`. These are deliberately illustrative, not current pricing. Capacity bounds must cover the entire possible request, including model-added input and Decisions output. Understating either invalidates the spending ceiling. Use conservative rates covering cache writes as well as uncached input. Cached-input discounts are deliberately ignored; reported costs are conservative token-price estimates, not invoice totals.

After approval, supply `OPENAI_API_KEY` through the environment or the existing gitignored `.env`, then start with one sample:

```sh
pnpm native-auto --out runs/auto-pilot --case queue-pin --samples 1 \
  --paid --approve-astra --pricing /absolute/path/private-prices.json \
  --max-output-tokens 4096
```

The fixed baseline uses the same model and effort as production's baseline profile; Auto calls the production Decisions classifier. No prompt or policy is copied. Every request reserves its worst-case token-priced cost before dispatch through the existing atomic $25 ledger. All paid invocations share `evals/runs/native-auto-budget.sqlite`; changing the output directory does not reset it. Keep this file, including unresolved reservations, throughout the pilot. Do not delete it to retry a failed run or raise the cap.

Responses output includes reasoning tokens within `--max-output-tokens`. Decisions retains the production one-second deadline. There are no inference retries. Transport failures, missing usage, cancellation, and exceeded pricing bounds retain ambiguous reservations and stop further dispatch. Known incomplete answers fail evaluation. Unambiguously billed invalid Decisions choices may fall back to baseline. If configured bounds or prices prove wrong, reconcile with provider billing before any new run; the ledger is an accounting guard, not a provider-enforced dollar cap.

## Review and acceptance

`results.jsonl` records each completed or failed arm as it finishes, including model, effort, policy, fallback, token usage, estimated cost and elapsed time. Auto totals include classification. Samples alternate arm order to reduce systematic cache/order bias. This does not make the samples independent or remove all timing bias.

Give a reviewer only `review.json`, which shuffles outputs and hides arm/model/timing/cost. Record independent correctness, required corrections, and notes against the rubric; a baseline mistake is still a failure. Keep `answer-key.json`, raw results and the manifest separate until grading is complete. The manifest deliberately retains the public fixture prompts; operational routing logs remain metadata-only.

`summary.json` reports objective passes/failures and pending human reviews separately. A passing edit needs no assertion changes; a failed edit requires corrective work that this one-attempt harness does not measure. Do not turn these numbers into full-task savings. Collect representative real-repository tasks, full Codex/tool/retry costs and completion times, plus a small independently reviewed blind sample before deciding whether to enable Auto. No numerical quality threshold is inferred from the savings target.

Generated source executes in a fresh directory with an empty environment, a ten-second subprocess ceiling, bounded output and Node's permission model: read access to that directory only, no network, child processes, native addons, workers or writes. Node permissions are defense in depth, not an OS sandbox for hostile native exploitation. Use a disposable machine for adversarial cases. Temporary source directories are deleted in `finally`; run artifacts stay in the private output directory until the operator removes them after review. Never put credentials or private user data in cases or artifacts.

API contract references: [Responses creation](https://developers.openai.com/api/reference/resources/responses/methods/create) and [Decisions creation](https://developers.openai.com/api/reference/resources/decisions/methods/create).
