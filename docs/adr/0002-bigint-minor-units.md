# ADR-0002: Store money as BIGINT minor units

- Status: Accepted
- Date: 2025-02-03

## Context

Amounts must be exact. Options: `NUMERIC(20,8)`, `BIGINT` minor units (cents),
or a decimal string with app-side arbitrary precision.

## Decision

`BIGINT`, minor units of the ledger's ISO-4217 currency. Currency is fixed per
ledger; entries have no currency column. On the wire, amounts are **integer strings** —
`{"amount": "10000", "currency": "USD"}` means $100.00. Sending `100.00` or a
JSON number is a 400.

## Rationale

- The balance invariant becomes integer addition: exact, no rounding policy, and
  the deferred constraint trigger is a trivial `SUM()` comparison.
- `NUMERIC` allows sub-minor-unit amounts, which immediately raises "who rounds,
  and when?" — a real question for FX and interest, and both are out of scope.
  Allowing the representation would invite the bug.
- JSON numbers are IEEE-754 doubles and silently lose precision above 2^53, and
  many client stacks parse them as floats regardless. Serializing amounts as
  integer _strings_ (`"10000"`) preserves the full BIGINT range end to end;
  `src/shared/money.ts` parses to JS `bigint` at the boundary and never lets a
  `number` into the domain.
- Rejected decimal-string + `decimal.js`: pushes correctness into app code, and
  the DB can no longer enforce the invariant.

## Consequences

- Positive: exactness is structural; fastest possible aggregation; trivial trigger.
- Negative: zero-decimal (JPY) and three-decimal (BHD) currencies need a
  per-currency exponent table for display — stored in `currencies(code, exponent)`
  and applied only at presentation. Adding FX later requires a new
  `currency_conversions` table rather than a column tweak; accepted, FX is out of v1.
