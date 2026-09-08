# SHI Agentic Platform

An engagement-management and company-practice application built with React, TypeScript, Node.js and PostgreSQL.

The application covers versioned engagement templates, teams, checklists, evidence and notes, readiness reviews, delivery tracking, readouts, knowledge/playbooks, training and fictional company challenges, discovery, outcomes and portfolio views.

## Run locally

Use Node.js 22 and PostgreSQL with a dedicated application database. PostgreSQL client tools are needed for backup and restore. Docker is not required.

1. Clone this repository and run `npm ci`.
2. Copy `.env.example` to `.env.local` and set your own database connection. Keep this file private.
3. Run `npm run db:migrate`, then `npm run build`.
4. Create the first administrator using the masked prompt described in [Local setup](docs/operations/LOCAL_SETUP.md).
5. Run `npm start` and open the address printed at startup. The default is loopback with an automatically assigned free port.

No account, client or engagement is created automatically. Database migrations preserve versioned records; do not edit migrations after applying them.

## Training and reviewer privacy

Company challenges provide fictional data and business context. Learners choose their use case, approach and outputs, then submit evidence and a proposal. Mentors use separately protected, versioned reviewer guides.

Private reviewer content, credentials and operational data are deliberately absent from this public repository. Administrators can author reviewer guides inside the application. Optional local guide imports must be supplied privately; do not commit answer keys or real client information. Work performed in Palantir takes place in a separately managed training environment.

## Verification

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Database tests create and remove their own disposable databases. The test database role therefore needs permission to create databases. Do not use a production database as a test target.

## Documentation

- [Build checklist](docs/BUILD_CHECKLIST.md)
- [Validation walkthrough](docs/VALIDATION_WALKTHROUGH.md)
- [Local setup and release staging](docs/operations/LOCAL_SETUP.md)
- [Backup and recovery](docs/operations/RECOVERY.md)
- [Shared deployment decisions](docs/operations/OPERATIONAL_GAPS.md)

The application has been qualified locally. Shared Ubuntu VPS deployment, TLS, corporate identity, monitoring and backup custody require environment-specific configuration and verification. Publishing this source does not deploy the service or transfer its database.

## Files intentionally excluded

Local environment files, private reviewer guides, database dumps, uploads, runtime data, logs, generated builds, dependencies and local coordination records are excluded from Git. Only placeholder configuration and fictional public test/sample fixtures belong in this repository.
