import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
    email = "designer@example.test";
  await bootstrapPracticeAdmin(h.pool, {
    email,
    displayName: "Template Designer",
    password,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await page
    .getByRole("button", { name: "Load draft definitions", exact: true })
    .click();
  const independent = () =>
    page
      .getByRole("button")
      .filter({
        has: page.getByRole("heading", { name: /Independent SHI delivery/i }),
      })
      .first();
  await independent().click();
  await page
    .getByLabel(
      "I have reviewed these proposed defaults, responsibilities and readiness rules.",
    )
    .check();
  await page
    .getByRole("button", { name: "Publish version 1", exact: true })
    .click();
  await independent().filter({ hasText: "published" }).waitFor();
  await independent().click();
  await page.getByText("Version 1 · published", { exact: true }).waitFor();
  const original = (
    await (await page.request.get(base + "/api/templates")).json()
  ).templates.find(
    (x: any) =>
      x.definition.name === "Independent SHI delivery" && x.version === 1,
  );
  assert(original);
  const clientResponse = await page.request.post(base + "/api/clients", {
    data: { name: "Designer client", requestKey: crypto.randomUUID() },
  });
  const client = (await clientResponse.json()).client;
  const admin = (await (await page.request.get(base + "/api/users")).json())
    .users[0];
  const engagementResponse = await page.request.post(
    base + "/api/engagements",
    {
      data: {
        clientId: client.id,
        templateKey: original.templateKey,
        templateVersion: 1,
        title: "Pinned before redesign",
        leadUserId: admin.id,
        requestKey: crypto.randomUUID(),
      },
    },
  );
  assert.equal(
    engagementResponse.status(),
    201,
    await engagementResponse.text(),
  );
  const designer = page.locator(".template-designer");
  await designer
    .locator("summary", { hasText: "Design a new version" })
    .click();
  await designer.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await designer
    .locator(".designer-basics textarea")
    .fill(
      "A revised independent delivery path with explicit operational proof.",
    );
  await designer
    .getByRole("button", { name: "Add evidence requirement", exact: true })
    .click();
  const evidenceCards = designer
    .locator(".designer-section")
    .nth(3)
    .locator(".designer-card");
  await evidenceCards
    .last()
    .getByLabel("Name", { exact: true })
    .fill("Operational walkthrough record");
  await designer
    .getByLabel("Reason for this version")
    .fill("Add a clear operational evidence option and clarify the purpose.");
  await designer
    .getByRole("button", { name: "Create draft version", exact: true })
    .click();
  await page.getByText("Version 2 · draft", { exact: true }).waitFor();
  await designer
    .locator(".designer-basics textarea")
    .fill("A corrected independent path with explicit operational evidence.");
  await designer
    .getByLabel("Reason for this correction")
    .fill("Correct the draft purpose after review.");
  await designer
    .getByRole("button", { name: "Save draft changes", exact: true })
    .click();
  await page.getByText("Draft version 2 saved.", { exact: true }).waitFor();
  await page
    .getByLabel(
      "I have reviewed these proposed defaults, responsibilities and readiness rules.",
    )
    .check();
  await page
    .getByRole("button", { name: "Publish version 2", exact: true })
    .click();
  const revised = page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: /Independent SHI delivery/i }),
    })
    .filter({ hasText: "Version 2" });
  await revised.waitFor();
  await revised.click();
  await page.getByText("Version 2 · published", { exact: true }).waitFor();
  const all = (await (await page.request.get(base + "/api/templates")).json())
      .templates,
    v1 = all.find(
      (x: any) => x.templateKey === original.templateKey && x.version === 1,
    ),
    v2 = all.find(
      (x: any) => x.templateKey === original.templateKey && x.version === 2,
    );
  assert.deepEqual(v1.definition, original.definition);
  assert.equal(
    v2.definition.purpose,
    "A corrected independent path with explicit operational evidence.",
  );
  assert(
    v2.definition.evidenceRequirements.some(
      (x: any) => x.name === "Operational walkthrough record",
    ),
  );
  const engagement = (
    await (await page.request.get(base + "/api/engagements")).json()
  ).engagements.find((x: any) => x.title === "Pinned before redesign");
  assert.equal(engagement.templateVersion, 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: structured template redesign publishes v2 while v1 and its engagement pin remain unchanged.",
  );
} finally {
  await browser.close();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await h.dispose();
}
