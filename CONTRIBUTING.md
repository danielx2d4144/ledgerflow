# Contributing

Setup, layout and the test strategy live in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
This file is the workflow.

## Before opening a pull request

```bash
npm run check
```

That runs lint, typecheck, format check, the test suite with coverage
thresholds, migration verification and the runtime dependency audit — the same
things CI runs, minus the Docker build and the real-Postgres/Redis services.

If you changed routes or schemas, regenerate the API document and commit it:

```bash
npm run openapi
```

`openapi.json` is checked in and CI fails on drift, because it is the artifact
consumers integrate against.

## Expectations for a change

- **Money paths need a test that would fail without the change.** For ledger
  logic, prefer adding a property to `tests/ledger-properties.test.ts` over one
  more example-based case.
- **Invariants belong in the database** when they can be expressed there. If
  application code is the only thing keeping the books balanced, the change is
  not finished.
- **Migrations are forward-only and backward compatible** with the previous
  release. `npm run db:verify` enforces the destructive-statement rule; see
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#migration-discipline) for why.
- **Every route declares `config.policy`.** A missing declaration fails closed to
  admin-only and fails the route-policy test.
- **New environment variables** go through `src/config/env.ts` with validation
  and a default that is safe in development and refused in production if unsafe,
  plus an entry in `.env.example`.
- **Comments explain why, not what.** The code says what it does.

## Decisions

Anything with a real tradeoff — a dependency, a storage choice, a semantic like
"what an idempotency key means" — gets an ADR in `docs/adr/`, numbered, in the
format: context → decision → rejected alternatives → consequences. When reality
contradicts an ADR later, amend it with the correction rather than quietly
deleting it (ADR-0005 is an example: BullMQ ordering did not survive contact
with the open-source package).

## Commits and pull requests

- Present-tense, specific commit subjects: `reject unbalanced entries at commit`,
  not `fix bug`.
- One logical change per PR. Refactors ship separately from behaviour changes.
- The PR description should say what changed, why, and what you did to convince
  yourself it works — including anything you could not verify locally.
- Do not add badges, benchmark claims or generated summaries. If a number is
  quoted anywhere in this repository, the method that produced it has to be in
  the repository too (see [docs/LOAD-TESTING.md](docs/LOAD-TESTING.md)).
