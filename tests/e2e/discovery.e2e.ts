import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { createPostgresHarness } from "../integration/postgres-harness.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import { bootstrapPracticeAdmin } from "../../apps/api/src/auth/bootstrap.js";
import { createApiServer } from "../../apps/api/src/server.js";
const browser = await chromium.launch(),
  harness = await createPostgresHarness().catch(async (e) => {
    await browser.close();
    throw e;
  }),
  server = createApiServer({ pool: harness.pool });
try {
  await runMigrations(harness.pool, await readMigrationFiles("migrations"));
  const password = randomBytes(24).toString("base64url");
  await bootstrapPracticeAdmin(harness.pool, {
    email: "discovery@example.test",
    displayName: "Discovery Lead",
    password,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  assert(a && typeof a !== "string");
  const base = `http://127.0.0.1:${a.port}`,
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.goto(base);
  await page
    .getByLabel("Email", { exact: true })
    .fill("discovery@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Sample data", exact: true })
    .waitFor();
  await page.request.post(base + "/api/samples/load", {
    data: {
      expectedRevision: 0,
      requestKey: randomUUID(),
      confirmation: "load-sample-data",
    },
  });
  const engagement = (
    await (await page.request.get(base + "/api/engagements")).json()
  ).engagements.find((x: { title: string }) =>
    x.title.includes("apprenticeship"),
  );
  assert(engagement);
  const root = `${base}/api/engagements/${engagement.id}`;
  const initialDiscovery = await page.request.get(root + "/discovery");
  assert.equal(initialDiscovery.status(), 200, await initialDiscovery.text());
  let scope = (
    await (
      await page.request.post(root + "/delivery/scopes", {
        data: {
          requestKey: randomUUID(),
          commitments: ["Operational workflow"],
          exclusions: ["Production deployment"],
          estimate: "Three weeks",
          acceptanceCriteria: ["Measured operator outcome"],
        },
      })
    ).json()
  ).record;
  await page.request.post(`${root}/delivery/scopes/${scope.id}/decision`, {
    data: {
      requestKey: randomUUID(),
      expectedRevision: scope.revision,
      decision: "accepted",
      rationale: "Agreed for discovery.",
    },
  });
  await page.reload();
  await page
    .getByRole("button", { name: engagement.title, exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Discovery and outcomes", exact: true })
    .waitFor();
  const section = page.locator(".discovery"),
    nav = section.getByRole("navigation", { name: "Discovery sections" });
  const current = () => section.locator(":scope > section:not([hidden])");
  await nav.waitFor();
  assert.equal(await nav.getByRole("button").count(), 5);
  await current()
    .locator("summary")
    .filter({ hasText: "Add discovery session" })
    .click();
  await current().getByLabel("Purpose").fill("Operator workflow interview");
  await current().getByLabel("Date", { exact: true }).fill("2026-09-08");
  await current()
    .getByLabel("Summary")
    .fill("Operators need a shorter exception handling path.");
  await current().getByRole("button", { name: "Add session" }).click();
  await page.getByText("Session added.", { exact: true }).waitFor();
  await nav.getByRole("button", { name: "Use cases" }).click();
  await current()
    .locator("summary")
    .filter({ hasText: "Add use case" })
    .click();
  await current()
    .getByLabel("Title", { exact: true })
    .fill("Resolve flagged orders");
  await current().getByLabel("Person or role").fill("Operations analyst");
  await current()
    .getByLabel("Problem statement")
    .fill("Flagged orders require several manual handoffs.");
  await current()
    .getByLabel("Desired outcome")
    .fill("Resolve a flagged order in one guided workflow.");
  await current().getByRole("button", { name: "Add use case" }).click();
  await nav.getByRole("button", { name: "Assumptions" }).click();
  await current()
    .locator("summary")
    .filter({ hasText: "Add assumption" })
    .click();
  await current()
    .getByLabel("Assumption")
    .fill("Required source fields are available.");
  await current().getByRole("button", { name: "Add assumption" }).click();
  await nav.getByRole("button", { name: "Approaches" }).click();
  await current()
    .locator("summary")
    .filter({ hasText: "Add approach" })
    .click();
  await current()
    .getByLabel("Title", { exact: true })
    .fill("Guided exception queue");
  await current()
    .getByLabel("Description")
    .fill("Prioritize and resolve exceptions in a guided queue.");
  await current().getByLabel("Effort value").fill("8");
  await current().getByLabel("Effort unit").fill("person-days");
  await current().getByRole("button", { name: "Add approach" }).click();
  await nav.getByRole("button", { name: "Outcomes" }).click();
  await current().getByLabel("Scope version").selectOption(scope.id);
  await current().getByRole("button", { name: "Link accepted scope" }).click();
  await page.getByText("Accepted scope linked.", { exact: true }).waitFor();
  await current()
    .locator("summary")
    .filter({ hasText: "Add outcome measure" })
    .click();
  await current()
    .getByLabel("Name", { exact: true })
    .fill("Median resolution time");
  await current().getByLabel("Unit").fill("minutes");
  await current().getByLabel("Baseline").fill("45");
  await current().getByLabel("Target").fill("20");
  await current().getByRole("button", { name: "Add outcome measure" }).click();
  await page.getByText("Outcome measure added.", { exact: true }).waitFor();
  await current()
    .locator("summary")
    .filter({ hasText: "Add observation" })
    .click();
  await current().getByLabel("Observed date").fill("2026-09-08");
  await current().getByLabel(/Value/).fill("31");
  await current()
    .getByLabel("Note")
    .fill("Measured across the practice dataset.");
  await current().getByRole("button", { name: "Add observation" }).click();
  await page.getByText("31 minutes", { exact: false }).waitFor();
  const metricEditor = current()
    .locator("details")
    .filter({ has: page.getByText("Edit outcome measure", { exact: true }) });
  await metricEditor.locator("summary").click();
  await metricEditor.getByLabel("Target", { exact: true }).fill("18");
  await metricEditor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page.getByText("Outcome measure updated.", { exact: true }).waitFor();
  const edited = (await (await page.request.get(root + "/discovery")).json())
    .discovery;
  assert.equal(Number(edited.outcomes[0].target), 18);
  assert.equal(edited.outcomes[0].observations.length, 1);
  await nav.getByRole("button", { name: "Assumptions", exact: true }).click();
  const assumptionEditor = current()
    .locator("details")
    .filter({ has: page.getByText("Edit assumption", { exact: true }) });
  await assumptionEditor.locator("summary").click();
  await assumptionEditor
    .getByLabel("Status", { exact: true })
    .selectOption("validated");
  await assumptionEditor
    .getByLabel("Rationale", { exact: true })
    .fill("Reviewed the supplied source extract.");
  await assumptionEditor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page.getByText("Assumption updated.", { exact: true }).waitFor();
  const revised = (await (await page.request.get(root + "/discovery")).json())
    .discovery;
  assert.equal(revised.assumptions[0].status, "validated");
  assert.equal(revised.assumptions.length, 1);
  const portfolioResponse = await page.request.get(base + "/api/portfolio");
  assert.equal(portfolioResponse.status(), 200, await portfolioResponse.text());
  const portfolioPayload = await portfolioResponse.json();
  const portfolioRow = portfolioPayload.engagements.find(
    (x: { id: string }) => x.id === engagement.id,
  );
  assert.equal(portfolioRow.outcomes[0].name, "Median resolution time");
  assert.equal(portfolioRow.outcomes[0].latestValue, 31);
  await page.getByRole("button", { name: "Portfolio", exact: true }).click();
  await page.getByRole("heading", { name: "Portfolio", exact: true }).waitFor();
  await page
    .getByLabel("Search engagements", { exact: true })
    .fill("no-such-engagement");
  await page.getByText("Showing 0 of 2 engagements", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.getByLabel("Focus", { exact: true }).selectOption("outcomes");
  await page.getByText("Showing 1 of 2 engagements", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh portfolio", exact: true })
    .click();
  const card = page
    .locator(".portfolio article")
    .filter({ hasText: engagement.title });
  await card.waitFor();
  await card.getByText("Median resolution time:", { exact: false }).waitFor();
  await card.getByText("31 minutes", { exact: false }).waitFor();
  await card.getByRole("button", { name: "Open engagement" }).click();
  await page
    .getByRole("heading", { name: engagement.title, exact: true })
    .waitFor();
  const sample = (await (await page.request.get(base + "/api/samples")).json())
    .sample;
  const removed = await page.request.post(base + "/api/samples/remove", {
    data: {
      expectedRevision: sample.revision,
      requestKey: randomUUID(),
      confirmation: "remove-sample-data",
    },
  });
  assert.equal(removed.status(), 200, await removed.text());
  console.log(
    "PASS: discovery records, accepted scope, named metric units/observations and authorized portfolio navigation.",
  );
} finally {
  await browser.close();
  if (server.listening) await new Promise<void>((r) => server.close(() => r()));
  await harness.dispose();
}
