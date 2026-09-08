import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";
import { createPostgresHarness } from "../integration/postgres-harness.js";
import {
  runMigrations,
  readMigrationFiles,
} from "../../packages/persistence/src/migrations.js";
import { bootstrapPracticeAdmin } from "../../apps/api/src/auth/bootstrap.js";
import { createApiServer } from "../../apps/api/src/server.js";

const browser = await chromium.launch();
const harness = await createPostgresHarness().catch(async (error) => {
  await browser.close();
  throw error;
});
const server = createApiServer({ pool: harness.pool });
let page: Page | undefined;
try {
  await runMigrations(harness.pool, await readMigrationFiles("migrations"));
  const password = randomBytes(24).toString("base64url");
  await bootstrapPracticeAdmin(harness.pool, {
    email: "sample-operator@example.test",
    displayName: "Sample Test Operator",
    password,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  page = await browser.newPage({ viewport: { width: 1350, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page
    .getByLabel("Email", { exact: true })
    .fill("sample-operator@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sample data", exact: true }).click();
  await page.getByText("Not loaded.", { exact: true }).waitFor();
  const missingConfirmation=await page.request.post(`${base}/api/samples/load`,{data:{expectedRevision:0,requestKey:randomUUID()}});
  assert.equal(missingConfirmation.status(),422);
  assert.equal(
    await page
      .getByRole("button", { name: "Load sample data", exact: true })
      .isEnabled(),
    false,
  );
  const realClient = await (
    await page.request.post(`${base}/api/clients`, {
      data: { name: "Ordinary retained client", requestKey: randomUUID() },
    })
  ).json();
  assert(realClient.client.id);
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Load sample data", exact: true })
    .click();
  await page.getByText("Loaded:", { exact: true }).waitFor();
  const first = await (
    await page.request.get(`${base}/api/engagements`)
  ).json();
  assert.equal(first.engagements.length, 2);
  for (const e of first.engagements) assert.match(e.title, /sample/i);
  await mkdir("work/browser", { recursive: true });
  await page.screenshot({
    path: "work/browser/sample-data-loaded.png",
    fullPage: true,
  });
  assert.equal(
    await page
      .getByRole("button", { name: "Remove sample data", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Remove sample data", exact: true })
    .click();
  await page.getByText("Not loaded.", { exact: true }).waitFor();
  assert.equal(
    (await (await page.request.get(`${base}/api/engagements`)).json())
      .engagements.length,
    0,
  );
  const clientsAfter = await (
    await page.request.get(`${base}/api/clients`)
  ).json();
  assert.deepEqual(clientsAfter.clients, [realClient.client]);
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Load sample data", exact: true })
    .click();
  await page.getByText("Loaded:", { exact: true }).waitFor();
  const second = await (
    await page.request.get(`${base}/api/engagements`)
  ).json();
  assert.equal(second.engagements.length, 2);
  assert(
    second.engagements.every(
      (e: { id: string }) =>
        !first.engagements.some((old: { id: string }) => old.id === e.id),
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "Sample data", exact: true }).click();
  await page.getByText("Loaded:", { exact: true }).waitFor();
  await page.getByRole('checkbox').check();
  const current=(await(await page.request.get(`${base}/api/samples`)).json()).sample;
  assert.equal((await page.request.post(`${base}/api/samples/remove`,{data:{expectedRevision:current.revision,requestKey:randomUUID(),confirmation:'remove-sample-data'}})).status(),200);
  await page.getByRole('button',{name:'Remove sample data',exact:true}).click();
  await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();
  await page.getByText('Not loaded.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Load sample data',exact:true}).isEnabled(),false);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: sample load, confirmed removal, reload, retained real client, persistent status and no browser errors.",
  );
} catch (error) {
  if (page) {
    await mkdir("work/browser", { recursive: true });
    await page.screenshot({
      path: "work/browser/sample-data-failure.png",
      fullPage: true,
    });
    console.log((await page.locator("body").innerText()).slice(0, 5000));
  }
  throw error;
} finally {
  await browser.close();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await harness.dispose();
}
