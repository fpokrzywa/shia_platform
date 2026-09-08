import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { bootstrapPracticeAdmin } from "../../apps/api/src/auth/bootstrap.js";
import { createApiServer } from "../../apps/api/src/server.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import { createPostgresHarness } from "../integration/postgres-harness.js";

const browser = await chromium.launch();
const harness = await createPostgresHarness().catch(async (error) => {
  await browser.close();
  throw error;
});
const server = createApiServer({ pool: harness.pool });
try {
  await runMigrations(harness.pool, await readMigrationFiles("migrations"));
  const password = randomBytes(24).toString("base64url");
  await bootstrapPracticeAdmin(harness.pool, {
    email: "training-designer@example.test",
    displayName: "Training Designer",
    password,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(base);
  await page
    .getByLabel("Email", { exact: true })
    .fill("training-designer@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Training", exact: true }).waitFor();

  const created = await page.request.post(`${base}/api/training/sets`, {
    data: {
      requestKey: randomUUID(),
      key: "maintainable-training",
      name: "Maintainable training",
      purpose: "Original published learning purpose.",
      items: [
        {
          key: "read",
          type: "reading",
          title: "Read the guide",
          description: "Read the delivery guide.",
          required: true,
          url: "https://example.test/guide",
        },
        {
          key: "practice",
          type: "practical",
          title: "Practice the method",
          description: "Apply the method with evidence.",
          required: true,
        },
      ],
    },
  });
  assert.equal(created.status(), 201, await created.text());
  const v1 = (await created.json()).version;
  const published = await page.request.post(
    `${base}/api/training/sets/maintainable-training/1/publish`,
    {
      data: { requestKey: randomUUID(), expectedRevision: Number(v1.revision) },
    },
  );
  assert.equal(published.status(), 200, await published.text());
  const learnerResponse = await page.request.post(`${base}/api/v1/auth/users`, {
    data: {
      email: "training-pin@example.test",
      displayName: "Pinned Learner",
      password,
      role: "member",
    },
  });
  const learnerId = (await learnerResponse.json()).data.user.id as string;
  const mentorResponse = await page.request.post(`${base}/api/v1/auth/users`, {
    data: {
      email: "training-mentor@example.test",
      displayName: "Pinned Mentor",
      password,
      role: "member",
    },
  });
  const mentorId = (await mentorResponse.json()).data.user.id as string;
  const assignmentResponse = await page.request.post(
    `${base}/api/training/assignments`,
    {
      data: {
        requestKey: randomUUID(),
        trainingKey: "maintainable-training",
        version: 1,
        learnerUserId: learnerId,
        mentorUserId: mentorId,
      },
    },
  );
  assert.equal(
    assignmentResponse.status(),
    201,
    await assignmentResponse.text(),
  );

  await page.getByRole("button", { name: "Training", exact: true }).click();
  await page
    .getByRole("button", { name: "Training sets", exact: true })
    .click();
  const v1Card = page
    .locator(".training-set-list article")
    .filter({ hasText: "Version 1" });
  await v1Card.getByRole("button", { name: "Create new version" }).click();
  const editor = page.getByRole("region", { name: "Training set editor" });
  await editor.getByLabel("Purpose").fill("A proposed learning purpose.");
  await editor
    .getByRole("button", { name: "Move Practice the method earlier" })
    .click();
  await editor
    .getByLabel("Reason for new version")
    .fill("Update the sequence after review.");
  await editor.getByRole("button", { name: "Create draft version" }).click();
  await page
    .getByText("New training draft created.", { exact: true })
    .waitFor();

  const v2Card = page
    .locator(".training-set-list article")
    .filter({ hasText: "Version 2" });
  await v2Card.getByRole("button", { name: "Edit draft" }).click();
  await editor
    .getByLabel("Name", { exact: true })
    .fill("Maintainable training, revised");
  await editor
    .getByLabel("Purpose")
    .fill("Corrected learning purpose after draft review.");
  await editor.getByRole("button", { name: "Save draft changes" }).click();
  await page.getByText("Training draft updated.", { exact: true }).waitFor();
  await v2Card.getByRole("button", { name: "Publish", exact: true }).click();
  await page
    .getByText("Maintainable training, revised published.", { exact: true })
    .waitFor();

  const before = (
    await (
      await page.request.get(
        `${base}/api/training/sets/maintainable-training/1`,
      )
    ).json()
  ).version;
  const after = (
    await (
      await page.request.get(
        `${base}/api/training/sets/maintainable-training/2`,
      )
    ).json()
  ).version;
  assert.equal(
    before.definition.purpose,
    "Original published learning purpose.",
  );
  assert.equal(
    after.definition.purpose,
    "Corrected learning purpose after draft review.",
  );
  assert.deepEqual(
    after.definition.items.map((item: { key: string }) => item.key),
    ["practice", "read"],
  );
  const assignments = (
    await (await page.request.get(`${base}/api/training/assignments`)).json()
  ).assignments;
  assert.equal(assignments[0].training_version, 1);
  await page.screenshot({
    path: "work/browser/training-designer.png",
    fullPage: true,
  });
  console.log(
    "PASS: generic training v2 was reordered, corrected and published while v1 assignment stayed pinned.",
  );
} finally {
  await browser.close();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await harness.dispose();
}
