# Local SHI Agentic setup

Run these commands from the application directory. Node.js 22.14 or newer in the supported 22.x line and PostgreSQL are available on this workstation. No Docker is used.

## Configuration

Optional built-in reviewer-guide imports are private operational content. The public source contains no answer guides. Administrators can author guides in **Company practice**. Alternatively, the server reads `private/practice-reference-content.json`, or the file named by `SHI_PRACTICE_REFERENCE_FILE`, at startup. Keep this file outside Git and transfer it only through a private channel. A missing file leaves built-in imports unavailable; custom guide authoring remains available. Its object maps training keys to `expectedApproach`, `checks`, `pitfalls`, `acceptableAlternatives` and `rubric` entries containing `criterion` and `description`. Do not place diagnostic findings in learner-facing challenge definitions.

Keep `DATABASE_URL` in `.env.local`, which is ignored by source control. Do not paste or print it. The application defaults to loopback with an operating-system-assigned available port. Startup prints the exact URL to open; the port may change on each start. `PORT=0` (or omitting PORT) selects automatically. An explicit nonzero `PORT` remains an operator override. `HOST` is configurable; keep loopback binding for local use. `AI_BASE_AGENT_API_KEY` is preserved but no AI providers are called.

Sessions use cryptographically random tokens stored as hashes in PostgreSQL and expire after eight hours. The unused optional `SESSION_SECRET` scaffold setting is not required for opaque sessions. Shared hosting, corporate sign-in, HTTPS/proxy configuration, retention and operating ownership remain future qualifications. Masked local password recovery is available to an operator with database access.

## Install and build

```powershell
npm ci
npm run build
```

The TypeScript server serves the built React application from `apps/web/dist`. After editing the interface, rebuild it with `npm run build:web`; API-only development can use `npm run dev`. No client records are loaded at startup.

## Apply reviewed migrations

```powershell
npm run db:migrate
```

Migrations acquire a database advisory lock, run within a transaction, and record checksums. Repeated execution skips recorded migrations. Never edit an already applied migration; add a new ordered migration. Do not point this command at the FDE Studio database.

## Create the first administrator

Run the masked prompt using the built-in Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
```

Enter your own email, display name and password. The password is read privately and passed on standard input, never a command-line argument. Bootstrap works only while there are zero accounts. There is no default password and no application account is created automatically. For automated operators, the underlying `apps/api/src/auth/bootstrap.ts` accepts `--email` and `--display-name`, with the password on standard input.

## Start and use

```powershell
npm start
```

Open the local address shown at startup and sign in. A practice administrator can create member accounts, load the two supplied draft template definitions, review their stage responsibilities and readiness rules, and publish an approved version. Loading templates creates configuration only. Clients and engagements are created deliberately. Each engagement pins one published version; its stage and checklist snapshots are created in one transaction.

Practice administrators manage engagement membership. Other users see only assigned engagements. Engagement roles are separate from platform privileges; the same person can be an engineer, technical lead and reviewer on an engagement. External approvers do not receive impersonated internal accounts.

The template detail screen includes a structured visual editor for roles, ordered stages and dependencies, checklist items, evidence requirements and readiness rules. An administrator can correct an existing draft with revision checks or create a new draft version from a published version with a reason. Published definitions remain immutable. Retiring a published version prevents new engagements from selecting it while existing engagements remain pinned and readable.

Open an engagement to update checklist status, assign an owner and due date, add item notes, attach evidence links or files (up to 2 MiB), and add running engagement notes. Evidence downloads require engagement access. Existing sample engagements support these actions without reloading. The Readiness review records reviewed not-applicable items and go, conditional-go, no-go or reopen decisions with rationale, role checks, evidence requirements and immutable history.

Use Sign out to revoke the current session. Stop the server with Ctrl+C.

## Verification

`npm test` runs unit, review and disposable PostgreSQL integration tests. The harness creates uniquely named databases and drops only the databases it created. An optional `TEST_DATABASE_URL` selects the test server; it must be distinct from the application target and the role must be able to create disposable databases. Tests never use application tables for fixtures.

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests use a separate disposable database and generated credentials. Screenshots in `work/browser` contain synthetic test fixtures only. A browser-installation failure happens before database provisioning.

Liveness is `/health/live`. `/health/ready` checks database connectivity and the running release's migration manifest; missing migrations or mismatched IDs or checksums return unavailable. These checks are live in release 14. If sign-in fails before account setup, apply migrations and run the administrator bootstrap. A database outage returns a generic error without connection credentials.

Backup and restore are qualified with disposable PostgreSQL data. Follow [RECOVERY.md](RECOVERY.md) for protected backups and fresh-target restore rehearsals. Retention, shared hosting, monitoring ownership, and disaster-recovery operating responsibility remain outstanding.

## Reset a local password

With migration `0012_identity_recovery.sql` applied, an operator with database access can reset exactly one enabled local account using a masked prompt:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/reset-password.ps1
```

The workflow matches email case-insensitively, never creates an account or changes its role, revokes every session for that account, and records a `password_reset` identity audit event with local operator recovery provenance. The password is carried on standard input and does not appear in process arguments or output. Missing and disabled accounts are rejected.

## Stage a verified release

After the combined build and tests pass, run `scripts/stage-web-release.ps1` with a unique release name and the highest verified migration number. It copies the compiled server, web assets and selected migration files into a new release directory and returns `serverEntry`, `webRoot` and `migrationsDir`. Existing releases are not overwritten. Release 14 was staged in `work/releases/release14-qualified`; its server/web hashes and all fourteen migration files were checked, then the staged application passed live readiness and access smoke checks.

For launch, use the returned server entry and set `WEB_ROOT` and `MIGRATIONS_DIR` to that release's paths in the child process environment. Keep the repository as working directory so the existing configuration is found. Preserve and restore any parent environment overrides. Use the available-port default and record the emitted address; provide that link after every restart.

Apply only verified migrations before launch and compare preserved data and secret-file hashes across the upgrade. A source or asset rollback is safe only if that older server is compatible with the upgraded schema; do not reverse migrations or overwrite the active database to make a rollback appear successful. A failed upgrade requires diagnosis or the separately qualified recovery procedure, including reconciliation of any work recorded after the backup.
