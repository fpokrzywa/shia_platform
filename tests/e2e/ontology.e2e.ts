import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { bootstrapPracticeAdmin } from "../../apps/api/src/auth/bootstrap.js";
import { createApiServer } from "../../apps/api/src/server.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import { createPostgresHarness } from "../integration/postgres-harness.js";

const browser = await chromium.launch(),
  h = await createPostgresHarness().catch(async (e) => {
    await browser.close();
    throw e;
  }),
  server = createApiServer({ pool: h.pool });
try {
  await runMigrations(h.pool, await readMigrationFiles("migrations"));
  const password = randomBytes(24).toString("base64url"),
    email = "ontology@example.test";
  await bootstrapPracticeAdmin(h.pool, {
    email,
    displayName: "Ontology Reviewer",
    password,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await mkdir("work/browser", { recursive: true });
  await page.goto(base);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Ontology", exact: true }).click();
  await page
    .getByRole("heading", { name: "Ontology overview", exact: true })
    .waitFor();
  for (const name of [
    "Discovery session",
    "Outcome metric and observation",
    "Training set and version",
    "Knowledge set and version",
    "Practice review reference",
    "Practice proposal",
    "Practice comparison",
  ]) {
    const detail = page
      .locator("details.ontology-object")
      .filter({ has: page.locator("summary", { hasText: name }) });
    await detail.locator("summary").click();
    assert.equal(
      await detail.evaluate((element) => (element as HTMLDetailsElement).open),
      true,
    );
  }
  const overviewText = await page.locator(".ontology").innerText();
  assert.match(
    overviewText,
    /Protected reviewer material is not learner content/,
  );
  assert.match(
    overviewText,
    /Private engagement sources and reviewer references keep their original access boundary/,
  );
  assert.doesNotMatch(
    overviewText,
    /PRIVATE CUSTOMER NAME|internal discovery detail|expected answer:/i,
  );
  await page.screenshot({
    path: "work/browser/ontology-overview.png",
    fullPage: true,
  });
  const [diagram] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("link", { name: /Open diagram/ }).click(),
  ]);
  await diagram
    .getByRole("heading", { name: "Ontology diagram", exact: true })
    .waitFor();
  const reference = diagram.getByRole("button", {
    name: "Inspect Practice review reference",
    exact: true,
  });
  await reference.focus();
  await reference.press("Enter");
  await diagram
    .getByRole("heading", { name: "Practice review reference", exact: true })
    .waitFor();
  await diagram
    .getByText(/Protected reviewer material is not learner content/)
    .waitFor();
  const relationSection = diagram.getByRole("region", {
    name: "Relationship list",
  });
  await relationSection
    .getByRole("button", { name: "Show all relationships", exact: true })
    .focus();
  await relationSection
    .getByRole("button", { name: "Show all relationships", exact: true })
    .press("Enter");
  await relationSection
    .getByRole("heading", { name: "All relationships", exact: true })
    .waitFor();
  assert((await relationSection.getByRole("listitem").count()) > 15);
  await diagram.screenshot({
    path: "work/browser/ontology-diagram-desktop.png",
    fullPage: true,
  });
  await diagram.setViewportSize({ width: 390, height: 844 });
  const canvas = diagram.locator(".ontology-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const dimensions = await canvas.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    overflow: getComputedStyle(element).overflowX,
  }));
  assert(dimensions.scroll > dimensions.client);
  assert(["auto", "scroll"].includes(dimensions.overflow));
  await canvas.evaluate((element) =>
    element.scrollTo({ left: element.scrollWidth }),
  );
  assert((await canvas.evaluate((element) => element.scrollLeft)) > 0);
  await diagram.screenshot({
    path: "work/browser/ontology-diagram-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: ontology overview and diagram are readable, keyboard-selectable, privacy-safe, and horizontally usable on mobile.",
  );
} finally {
  await browser.close();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await h.dispose();
}
