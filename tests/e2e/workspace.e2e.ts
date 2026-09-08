import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createPostgresHarness } from "../integration/postgres-harness.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import { bootstrapPracticeAdmin } from "../../apps/api/src/auth/bootstrap.js";
import { createApiServer } from "../../apps/api/src/server.js";

// Every browser fixture stays in a newly created disposable database.
const browser = await chromium.launch({ headless: true });
const harness = await createPostgresHarness().catch(async (error) => {
  await browser.close();
  throw error;
});
const server = createApiServer({ pool: harness.pool });
const password = randomBytes(24).toString("base64url");
const email = "operator@example.test";
let activePage: import("@playwright/test").Page | undefined;
try {
  await runMigrations(harness.pool, await readMigrationFiles("migrations"));
  await bootstrapPracticeAdmin(harness.pool, {
    email,
    displayName: "Test Operator",
    password,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  activePage = page;
  page.setDefaultTimeout(15000);
  const serverFailures: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500)
      serverFailures.push(
        `HTTP ${response.status()} ${new URL(response.url()).pathname}`,
      );
    if (response.status() >= 400)
      console.log(
        `HTTP ${response.status()} ${new URL(response.url()).pathname}`,
      );
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  await mkdir("work/browser", { recursive: true });
  await page.screenshot({ path: "work/browser/sign-in.png", fullPage: true });
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Email or password is incorrect" })
    .waitFor();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Your next engagement starts here" })
    .waitFor();
  await page.screenshot({
    path: "work/browser/empty-workspace.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await page.getByRole("button", { name: "Load draft definitions" }).click();
  const row = page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: /Independent/i }) });
  await row.click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Publish version 1" }).click();
  await row.filter({ hasText: "published" }).waitFor();
  await row.click();
  await page.getByText("Version 1 · published", { exact: true }).waitFor();
  await page.screenshot({
    path: "work/browser/template-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Engagements", exact: true }).click();
  await page
    .getByRole("button", { name: "Create engagement", exact: true })
    .click();
  await page.getByText("Add a client", { exact: true }).click();
  await page
    .getByLabel("Client name", { exact: true })
    .fill("Isolated browser client");
  await page.getByRole("button", { name: "Add client", exact: true }).click();
  await page
    .getByRole("combobox", { name: /^Client/ })
    .selectOption({ label: "Isolated browser client" });
  await page
    .getByLabel("Engagement title", { exact: true })
    .fill("Browser preparation workflow");
  await page
    .getByLabel("Accountable engagement lead")
    .selectOption({ label: `Test Operator (${email})` });
  await page
    .getByRole("button", { name: "Create engagement", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Browser preparation workflow", exact: true })
    .waitFor();
  await page
    .getByRole("navigation", { name: "Engagement stages", exact: true })
    .waitFor();
  const engagementId = (
    await (await page.request.get(base + "/api/engagements")).json()
  ).engagements[0].id as string;
  assert.equal(
    await page
      .getByRole("navigation", { name: "Engagement stages", exact: true })
      .getByRole("button")
      .count(),
    6,
  );
  assert.equal(await page.getByText(/Palantir/).count(), 0);
  await page.screenshot({
    path: "work/browser/engagement.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: "Independent SHI delivery",
        exact: true,
      }),
    })
    .click();
  const revisionForm = page.locator("form").filter({
    has: page.getByLabel("Reason for revision", { exact: true }),
  });
  await revisionForm
    .getByLabel("Template name", { exact: true })
    .fill("Independent SHI delivery revised");
  await revisionForm
    .getByLabel("Reason for revision", { exact: true })
    .fill("Browser version maintenance check");
  await page
    .getByRole("button", { name: "Create draft version", exact: true })
    .click();
  const revised = page.getByRole("button").filter({
    has: page.getByRole("heading", {
      name: "Independent SHI delivery revised",
      exact: true,
    }),
  });
  await revised.click();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Publish version 2", exact: true })
    .click();
  await revised.filter({ hasText: "published" }).waitFor();
  await page
    .getByLabel("Template version filter", { exact: true })
    .selectOption("all");
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: "Independent SHI delivery",
        exact: true,
      }),
    })
    .click();
  await page.getByText("Retire this version", { exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Retire version 1 for new engagements." })
    .check();
  await page
    .getByRole("button", { name: "Retire version 1", exact: true })
    .click();
  await page.getByLabel("Template status", { exact: true }).selectOption("all");
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: "Independent SHI delivery",
        exact: true,
      }),
    })
    .filter({ hasText: "retired" })
    .waitFor();
  const pinned = (
    await (
      await page.request.get(`${base}/api/engagements/${engagementId}`)
    ).json()
  ).engagement;
  assert.equal(pinned.templateVersion, 1);
  assert.equal(pinned.stages.length, 6);
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByLabel("Full name").fill("Test Engineer");
  await page.getByLabel("Email", { exact: true }).fill("engineer@example.test");
  await page.getByLabel("Initial password").fill(password);
  await page.getByRole("button", { name: "Create member account" }).click();
  await page.getByRole("status").waitFor();
  await page.getByRole("button", { name: "Engagements", exact: true }).click();
  await page
    .getByRole("button", { name: "Browser preparation workflow", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: /^Team member/ })
    .selectOption({ label: "Test Engineer" });
  await page
    .getByRole("combobox", { name: /^Engagement role/ })
    .selectOption("engineer");
  await page.getByRole("button", { name: "Assign role", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Remove engineer role from Test Engineer",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Remove engineer role from Test Engineer",
      exact: true,
    })
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  await page.getByLabel("Email", { exact: true }).fill("engineer@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Your next engagement starts here" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Create engagement", exact: true })
      .count(),
    0,
  );
  for (const route of [
    `/api/engagements/${engagementId}`,
    `/api/engagements/${engagementId}/members`,
  ])
    assert.equal((await page.request.get(base + route)).status(), 403);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: "work/browser/mobile.png", fullPage: true });
  await harness.pool.query("UPDATE app_sessions SET expires_at=now()");
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(serverFailures, []);
  console.log(
    "PASS: browser sign-in failure/success, empty state, draft publication, client and engagement creation, stage pinning, member account and denied outside access, sign-out, mobile layout, no page errors.",
  );
} catch (error) {
  if (activePage) {
    await activePage.screenshot({
      path: "work/browser/failure.png",
      fullPage: true,
    });
    console.log((await activePage.locator("body").innerText()).slice(0, 6000));
  }
  throw error;
} finally {
  await browser.close();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await harness.dispose();
}
