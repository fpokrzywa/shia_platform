import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium, type Page } from "@playwright/test";
import { createApiServer } from "../../apps/api/src/server.js";
import { hashPassword } from "../../apps/api/src/auth/index.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import { SampleService } from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "../integration/postgres-harness.js";

const browser = await chromium.launch(),
  h = await createPostgresHarness().catch(async (e) => {
    await browser.close();
    throw e;
  }),
  server = createApiServer({ pool: h.pool });
async function login(
  page: Page,
  base: string,
  email: string,
  password: string,
) {
  await page.goto(base);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Knowledge", exact: true }).waitFor();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page
    .getByRole("heading", { name: "Knowledge library", exact: true })
    .waitFor();
}
try {
  await runMigrations(h.pool, await readMigrationFiles("migrations"));
  const password = randomBytes(18).toString("base64url"),
    admin = {
      id: randomUUID(),
      email: "knowledge-admin@example.test",
      name: "Knowledge Admin",
      role: "practice_admin",
    },
    author = {
      id: randomUUID(),
      email: "knowledge-author@example.test",
      name: "Knowledge Author",
      role: "member",
    },
    reviewer = {
      id: randomUUID(),
      email: "knowledge-reviewer@example.test",
      name: "Knowledge Reviewer",
      role: "member",
    };
  for (const u of [admin, author, reviewer])
    await h.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
      [u.id, u.email, u.name, await hashPassword(password), u.role],
    );
  const loaded = await new SampleService(h.pool).load(
      { id: admin.id, role: "practice_admin" },
      {
        expectedRevision: 0,
        requestKey: randomUUID(),
        confirmation: "load-sample-data",
      },
    ),
    eid = loaded.engagementIds[0]!,
    noteId = randomUUID();
  await h.pool.query(
    "INSERT INTO workspace_engagement_memberships(engagement_id,user_id,role,added_by) VALUES($1,$2,'engineer',$4),($1,$3,'reviewer',$4)",
    [eid, author.id, reviewer.id, admin.id],
  );
  await h.pool.query(
    "INSERT INTO workspace_engagement_notes(id,engagement_id,actor_id,body) VALUES($1,$2,$3,$4)",
    [
      noteId,
      eid,
      author.id,
      "PRIVATE CUSTOMER NAME and internal discovery detail",
    ],
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const authorPage = await browser.newPage();
  await login(authorPage, base, author.email, password);
  const submitted = await authorPage.request.post(
    `${base}/api/engagements/${eid}/knowledge/submit`,
    {
      data: {
        requestKey: randomUUID(),
        source: { type: "note", id: noteId },
        key: "safe-discovery",
        kind: "discovery_guide",
        title: "Safe discovery prompts",
        summary: "A reusable sequence for early discovery.",
        body: "Ask for the current workflow, accountable owner, and observable outcome.",
        sourceRefs: [
          {
            title: "Discovery reference",
            url: "https://example.com/discovery",
          },
        ],
      },
    },
  );
  assert.equal(submitted.status(), 201, await submitted.text());
  await authorPage
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await authorPage
    .getByRole("button", { name: /Safe discovery prompts/ })
    .click();
  assert.equal(
    (await authorPage.locator("body").innerText()).includes(
      "PRIVATE CUSTOMER NAME",
    ),
    false,
  );
  await authorPage
    .locator("summary")
    .filter({ hasText: "Submit for review" })
    .click();
  await authorPage
    .getByLabel("Submission rationale")
    .fill("The text is sanitized and reusable.");
  await authorPage
    .getByRole("button", { name: "Send for review", exact: true })
    .click();
  await authorPage.getByText("Sent for review.", { exact: true }).waitFor();
  const reviewerPage = await browser.newPage();
  await login(reviewerPage, base, reviewer.email, password);
  await reviewerPage
    .getByRole("button", { name: /Safe discovery prompts/ })
    .click();
  assert.equal(
    (await reviewerPage.locator("body").innerText()).includes(
      "PRIVATE CUSTOMER NAME",
    ),
    false,
  );
  await reviewerPage
    .locator("summary")
    .filter({ hasText: "Review this version" })
    .click();
  await reviewerPage
    .getByLabel("Review rationale")
    .fill("Clear, generalized, and safe to reuse.");
  await reviewerPage
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await reviewerPage
    .getByText("Knowledge published.", { exact: true })
    .waitFor();
  let versions = (
    await (await reviewerPage.request.get(`${base}/api/knowledge`)).json()
  ).versions;
  const v1 = versions.find(
    (v: any) => v.knowledge_key === "safe-discovery" && v.version === 1,
  );
  assert(v1);
  assert.equal(
    (
      await reviewerPage.request.post(
        `${base}/api/engagements/${eid}/knowledge`,
        {
          data: {
            requestKey: randomUUID(),
            key: "safe-discovery",
            version: 1,
            rationale: "Use this reviewed guide",
          },
        },
      )
    ).status(),
    201,
  );
  await authorPage
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await authorPage
    .getByRole("button", { name: /Safe discovery prompts/ })
    .click();
  await authorPage
    .locator("summary")
    .filter({ hasText: "Create a new version" })
    .click();
  await authorPage
    .getByLabel("Reason for change")
    .fill("Add a second facilitation pass.");
  await authorPage
    .getByRole("button", { name: "Create draft version", exact: true })
    .click();
  await authorPage
    .getByText("New draft version created.", { exact: true })
    .waitFor();
  const links = (
    await (
      await authorPage.request.get(`${base}/api/engagements/${eid}/knowledge`)
    ).json()
  ).links;
  assert.equal(links[0].knowledge_version, 1);
  versions = (
    await (await authorPage.request.get(`${base}/api/knowledge`)).json()
  ).versions;
  assert(
    versions.some(
      (v: any) =>
        v.knowledge_key === "safe-discovery" &&
        v.version === 2 &&
        v.state === "draft",
    ),
  );
  console.log(
    "PASS: knowledge author-reviewer publication, source privacy, and pinned version reuse.",
  );
} finally {
  await browser.close();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await h.dispose();
}
