# polymarket-weather-trade Operations Runbook

## Lifecycle Commands
- Start local runtime: `npm run dev:up`
- Check status: `npm run dev:status`
- Smoke checks: `npm run dev:smoke`
- Stop runtime: `npm run dev:down`

## Incident and Recovery Steps
1. Check health probes first:
   - `GET /health/live`
   - `GET /health/ready`
   - `GET /health`
2. Inspect structured incidents and breakers:
   - `GET /ops/incidents`
   - `GET /ops/circuit-breakers`
3. Inspect recent execution intents and expected fills:
   - `GET /ops/executions`
   - `GET /ops/expected-fills`
   - `GET /ops/reconciliation`
4. Inspect telemetry for failure patterns:
   - `GET /metrics`
   - `GET /slo`
5. If breaker is open repeatedly, keep `TRADING_MODE=paper` and investigate:
   - Venue/API errors
   - Wallet/API credentials
   - Order sizing/tick-size mismatches
6. For stale expected fills:
   - Check if order remains open on venue
   - Cancel/replace stale order if needed
   - Record reconciliation decision in ops notes

## Safety Mode Transitions
1. Keep `TRADING_MODE=paper` during incident response.
2. Switch to `live` only with explicit confirmation:
   - `POST /trading-mode?confirm=true` with body `{ "mode": "live" }`
3. Verify before and after mode switch:
   - `GET /trading-mode`
   - `GET /health/ready`
   - `GET /ops/circuit-breakers`

## PR-A Threshold Tuning (Validator + Boundary Guard)
1. Query gate outcomes from ops metrics:
   - `GET /metrics?limit=500` (ops auth required)
   - Review `summaries.prA`:
     - `aiValidatorRejects`
     - `boundaryGuardRejects`
     - `prAShareOfGateRejectionsPct`
2. If validator rejections are too high for otherwise healthy periods:
   - relax borderline zone by lowering `AI_VALIDATOR_CONFIDENCE_MAX` and/or `AI_VALIDATOR_EDGE_MAX` scope.
3. If boundary rejections are too low and threshold misses increase:
   - widen `BOUNDARY_NO_TRADE_BAND_DEG`.
4. Only loosen override thresholds with evidence:
   - `BOUNDARY_OVERRIDE_CONFIDENCE`
   - `BOUNDARY_OVERRIDE_EDGE`
5. Apply changes through settings API (ops auth required):
   - `POST /settings/data` with `{ "values": { ... } }`
6. Re-check in the next scan windows using `/metrics`, `/ops/audit`, and `/ops/reconciliation` before additional tuning.
