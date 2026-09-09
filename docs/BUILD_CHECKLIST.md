# SHI Agentic build checklist

Updated September 9, 2026. This is the application build checklist. The live tracker reads its private build-progress record every five seconds. Status changes reflect verification, not merely code being written. Release 14 is verified on the local workstation and the owner-managed VPS has passed public health and authenticated read-only interface checks. Shared operating decisions are not yet qualified.

## Live and verified

- [x] Local application and PostgreSQL, available-port startup, first administrator setup, sign-in/out and access controls.
- [x] Clients, engagement creation, team roster and engagement role assignments.
- [x] Apprenticeship and independent-delivery template definitions; draft review, publication, immutable versions and retirement.
- [x] Engagements retain their selected template version and their own stage/checklist records.
- [x] Compact stage tabs, actionable checklist status, owners/dates, completion/reopening history, notes and evidence files/links.
- [x] Readiness reviews with required prerequisites, reviewed not-applicable decisions, go/conditional-go/no-go and decision history.
- [x] Template archive/restore protections and working/sample/archived, status and version filters.
- [x] Sample pack load, confirmed removal and reload, with ordinary-record protection and retained template/audit history.
- [x] Read-only ontology overview and interactive relationship diagram with object properties and focused links.
- [x] Delivery scope versions, milestones, risks, decisions, deliverables, acceptance and follow-up obligations.
- [x] Dated engagement readout snapshots, readable preview, review, export and stale-source warnings.

Live release evidence: release 14 is running locally from the immutable staged directory `work/releases/release14-qualified` with migrations 1-14 applied. The final suite passed 83 of 83 tests, readiness and anonymous-access smoke checks passed, and `work/release14-preservation.json` confirms the original rows, columns and `.env.local` remained unchanged across the upgrade.

## Release 14 additions: live and verified

These capabilities are included in the current staged local release with migrations 9-14.

- [x] Visual template designer: structured roles, stages, checklist items, evidence and readiness rules; new-version and draft-correction browser tests preserve published definitions and engagement pins (`tests/e2e/template-designer.e2e.ts`, `tests/integration/template-draft.postgres.test.ts`).
- [x] Knowledge/playbooks: draft, review, publication, immutable versions, source privacy and pinned engagement reuse (`tests/e2e/knowledge.e2e.ts`, `tests/integration/knowledge.postgres.test.ts`).
- [x] Discovery/scoping: sessions, use cases, assumptions, approaches, estimates, accepted-scope links and revision-preserving corrections (`tests/e2e/discovery.e2e.ts`, `tests/integration/discovery.postgres.test.ts`).
- [x] Outcomes/portfolio: baselines, targets, observations, evidence, authorized summaries, search, focus filters, refresh and engagement navigation (`tests/e2e/discovery.e2e.ts`).
- [x] Training: reusable generic sets, assignments, evidence, learning logs, mentor feedback, structured new-version editing and draft corrections with assignment pins preserved (`tests/e2e/training.e2e.ts`, `tests/e2e/training-designer.e2e.ts`, `tests/integration/training.postgres.test.ts`).
- [x] Readout expansion: discovery, measured outcomes and published learning/knowledge references, while restricted learner work and private provenance stay excluded (`tests/integration/readouts.postgres.test.ts`, `tests/e2e/delivery.e2e.ts`).
- [x] Ontology objects and properties cover the added modules, distinguish protected reviewer references from learner content, and remain keyboard/mobile usable (`tests/e2e/ontology.e2e.ts`).
- [x] The combined automated suite passed 83 of 83 tests independently after the source changes.
- [x] Apply migrations 9-14, preserve existing data and secrets, stage immutable application assets and restart.
- [x] Run post-restart health, home-page and anonymous-access smoke checks against the normal server.
- [x] Record the new local application link after restart and provide `docs/VALIDATION_WALKTHROUGH.md` for user validation.

## Company practice exercises: agreed learner experience

- [x] Define two fictional company challenges with raw sample datasets and field descriptions.
- [x] Make datasets downloadable from the learner exercise; CSV download is covered by `tests/e2e/practice.e2e.ts` and custom dataset authoring by `tests/e2e/practice-authoring.e2e.ts`.
- [x] Let a learner start a published exercise and record their own selected problem, rationale, questions, approach, deliverables and success criteria.
- [x] Keep prescribed deliverables, diagnostic findings, solution steps and answer keys out of learner content; learner/private-reference isolation tests pass.
- [x] Keep reviewer references as separate immutable versioned records with protected access.
- [x] Support mentor assignment and comparison against a specific learner proposal and reference version, including valid alternative approaches.
- [x] Preserve feedback history and flag comparisons as stale when the learner revises the proposal.
- [x] Verify that learner identity cannot access the protected reference, including the administrator/learner overlap case (`tests/integration/practice-reviews.postgres.test.ts`).
- [x] Verify the complete learner/mentor browser journey and dataset downloads (`tests/e2e/practice.e2e.ts`).
- [ ] User validation, followed by iterative refinements.

The learner investigates and builds in an approved Palantir training environment. This application manages the fictional challenge, data, learner proposal/evidence and review. It does not claim to provision or execute a Palantir environment.

## Operational qualification

- [x] Rehearse backup and restore using disposable databases, including migration and binary-evidence checks.
- [x] Release and verify masked operator password recovery, migration-current health checks and aggregate operational status.
- [x] Verify session cleanup dry run and explicit execution preserve active sessions and business history (`tests/integration/operations.postgres.test.ts`).
- [x] Verify staged assets and migration manifests isolate the running release from subsequent builds (`tests/integration/staged-release.postgres.test.ts`).
- [ ] Document and rehearse deployment, upgrade and rollback procedures for the chosen shared environment.
- [x] Confirm deployment destination and owner: the user installed the application on their Ubuntu VPS and manages PostgreSQL and private environment files.
- [x] Verify deployed HTTPS liveness/readiness and correct sign-in origin handling. Public endpoint checks passed September 9; the user confirmed successful sign-in September 8.
- [x] Verify the deployed signed-in interface without changing business data: navigation, portfolio, templates, company practice, training and knowledge screens render; template filters and archive categories are present; no browser warnings or errors appeared (September 9).
- [ ] Qualify production secret storage, service supervision and the remaining environment-specific operating controls with the owner.
- [ ] Confirm corporate identity provider and lifecycle requirements; local accounts do not constitute SSO.
- [ ] Confirm retention/legal holds, alert destinations, backup storage/encryption and recovery objectives.

The environment-specific decisions are listed in `docs/operations/OPERATIONAL_GAPS.md`. No automated deletion of business history is authorized or configured. Existing application data and secrets must remain preserved. Docker is outside the current scope.

Deployment ownership is a user-managed handoff; SSH access is not a prerequisite for the assistant's PostgreSQL checks. The HTTPS proxy correction is published with explicit `PUBLIC_ORIGIN` configuration. The deployment has passed an authenticated read-only interface check without creating, editing, publishing, or deleting records. That does not substitute for owner-led acceptance testing of business mutations or an environment-specific rollback rehearsal.

## Separate later increment

- [ ] Controlled AI assistance: a bounded, human-reviewed workflow after core workflow qualification. No provider calls have been made; this remains explicitly deferred.

## Completion audit corrections

These are implementation gaps found by reviewing the end-to-end workflow, not additional unrelated modules:

- [x] Template drafts can be corrected with revision checks before publication; published definitions and existing engagement pins are preserved. Focused database and browser checks passed.
- [x] Generic training drafts support full content/item corrections, reordering and usable version authoring; browser coverage preserves the prior assignment pin.
- [x] Unpublished training remains private; administrator assessment overrides are explicit and auditable (`tests/integration/training.postgres.test.ts`).
- [x] Company practice supports custom scenario/dataset authoring and draft/version corrections alongside the built-in cases (`tests/e2e/practice-authoring.e2e.ts`).
- [x] Reviewer-guide draft correction and new immutable reference versions pass final browser and upload-limit qualification; the original published guide remains unchanged.
- [x] Discovery correction forms preserve revision history and existing outcome observations (`tests/e2e/discovery.e2e.ts`).
- [x] Portfolio search, client/status/focus filters, refresh and engagement navigation are browser verified (`tests/e2e/discovery.e2e.ts`).

The company-practice learner/mentor browser workflow has passed: challenge publication, private guide review/publication, learner self-start, CSV download, evidence and notes, proposals, mentor assignment/comparison, criterion feedback and stale-feedback warning. The combined normal-server release and final reviewer-guide version UI checks passed. User validation and shared-environment decisions remain pending.
