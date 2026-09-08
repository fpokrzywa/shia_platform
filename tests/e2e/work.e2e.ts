import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { createPostgresHarness } from "../integration/postgres-harness.js";
import { runMigrations, readMigrationFiles } from "../../packages/persistence/src/migrations.js";
import { bootstrapPracticeAdmin } from "../../apps/api/src/auth/bootstrap.js";
import { createApiServer } from "../../apps/api/src/server.js";

const browser = await chromium.launch();
const harness = await createPostgresHarness().catch(async error => { await browser.close(); throw error; });
const server = createApiServer({pool:harness.pool});
try {
  await runMigrations(harness.pool,await readMigrationFiles("migrations"));
  const password = randomBytes(24).toString("base64url");
  await bootstrapPracticeAdmin(harness.pool,{email:"work-review@example.test",displayName:"Work Reviewer",password});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); assert(address && typeof address!=="string");
  const base=`http://127.0.0.1:${address.port}`;
  const page=await browser.newPage({viewport:{width:1400,height:1000}});
  page.setDefaultTimeout(15000);
  const errors:string[]=[]; page.on("pageerror",error=>errors.push(error.message));
  await page.goto(base);
  await page.getByLabel("Email",{exact:true}).fill("work-review@example.test");
  await page.getByLabel("Password",{exact:true}).fill(password);
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await page.getByRole("button",{name:"Sample data",exact:true}).waitFor();
  assert.equal((await page.request.post(base+"/api/samples/load",{data:{expectedRevision:0,requestKey:randomUUID(),confirmation:"load-sample-data"}})).status(),200);
  const engagements=(await (await page.request.get(base+"/api/engagements")).json()).engagements;
  const engagement=engagements[0]; const workUrl=`${base}/api/engagements/${engagement.id}/work`;
  const work=(await (await page.request.get(workUrl)).json()).work;
  assert(work.items.length>0);
  const item=work.items[0];
  for(const requirement of item.evidenceRequirementKeys ?? []) {
    assert.equal((await page.request.post(workUrl+"/evidence",{data:{requestKey:randomUUID(),itemId:item.id,title:"Required preparation evidence",url:"https://example.test/evidence",evidenceRequirementKey:requirement}})).status(),201);
  }
  const changed=await page.request.post(`${workUrl}/items/${item.id}`,{data:{requestKey:randomUUID(),expectedRevision:item.revision,status:"complete"}});
  assert.equal(changed.status(),200);
  assert.equal((await changed.json()).item.status,"complete");
  const stale=await page.request.post(`${workUrl}/items/${item.id}`,{data:{requestKey:randomUUID(),expectedRevision:item.revision,status:"blocked"}});
  assert.equal(stale.status(),409);
  const note=await page.request.post(workUrl+"/notes",{data:{requestKey:randomUUID(),text:"Review notes persist across refresh."}});
  assert.equal(note.status(),201);
  const evidence=await page.request.post(workUrl+"/evidence",{data:{requestKey:randomUUID(),itemId:item.id,title:"Supporting test document",fileName:"review.txt",mediaType:"text/plain",base64:Buffer.from("Verified evidence").toString("base64")}});
  assert.equal(evidence.status(),201);
  const evidenceId=(await evidence.json()).evidence.id;
  const download=await page.request.get(`${workUrl}/evidence/${evidenceId}/download`);
  assert.equal(download.status(),200); assert.match(download.headers()["content-disposition"]!,/^attachment;/);
  assert.equal(download.headers()["content-type"],"application/octet-stream");
  assert.equal((await download.body()).toString(),"Verified evidence");
  assert.equal((await page.request.post(workUrl+"/evidence",{data:{requestKey:randomUUID(),itemId:item.id,title:"Invalid link",url:"javascript:alert(1)"}})).status(),422);
  await page.reload();
  await page.getByRole("button",{name:engagement.title,exact:true}).click();
  await page.getByText("Review notes persist across refresh.",{exact:false}).waitFor();
  const article=page.locator("article.work-item").filter({has:page.getByRole("heading",{name:item.name,exact:true})});
  assert.equal(await article.getByLabel(`Status for ${item.name}`,{exact:true}).isVisible(),false);
  await article.getByRole("checkbox",{name:`Reopen ${item.name}`,exact:true}).click();
  await article.getByRole("checkbox",{name:`Mark ${item.name} complete`,exact:true}).waitFor();
  await article.getByRole("checkbox",{name:`Mark ${item.name} complete`,exact:true}).click();
  await article.getByRole("checkbox",{name:`Reopen ${item.name}`,exact:true}).waitFor();
  await article.locator("summary").click();
  await article.getByLabel("Add item note",{exact:true}).fill("Draft survives stage switching.");
  const stageNav=page.getByRole("navigation",{name:"Engagement stages",exact:true});
  await stageNav.getByRole("button").nth(1).click();
  assert.equal(await article.isVisible(),false);
  await stageNav.getByRole("button").first().click();
  assert.equal(await article.getByLabel("Add item note",{exact:true}).inputValue(),"Draft survives stage switching.");
  await page.getByText("Supporting test document",{exact:true}).waitFor();
  await article.getByLabel(`Status for ${item.name}`,{exact:true}).selectOption("in_progress");
  await article.getByLabel(`Due date for ${item.name}`,{exact:true}).fill("2026-10-15");
  assert.equal(await article.getByRole("checkbox").isDisabled(),true);
  await article.getByRole("button",{name:"Save changes",exact:true}).click();
  await page.getByText(`${item.name} was updated.`,{exact:true}).waitFor();
  assert.equal(await article.getByLabel("Add item note",{exact:true}).inputValue(),"Draft survives stage switching.");
  await article.getByLabel("Add item note",{exact:true}).fill("Item discussion from the browser.");
  await article.getByRole("button",{name:"Add note",exact:true}).click();
  await article.getByText("Item discussion from the browser.",{exact:false}).waitFor();
  await article.getByLabel("Evidence title",{exact:true}).fill("Browser attachment");
  await article.getByLabel("Or attachment",{exact:true}).setInputFiles({name:"browser.txt",mimeType:"text/plain",buffer:Buffer.from("Browser evidence")});
  await article.getByRole("button",{name:"Add evidence",exact:true}).click();
  await article.getByText("Browser attachment",{exact:true}).waitFor();
  await page.getByLabel("Add engagement note",{exact:true}).fill("Running journal browser entry.");
  await page.locator(".running-notes").getByRole("button",{name:"Add note",exact:true}).click();
  await page.getByText("Running journal browser entry.",{exact:false}).waitFor();
  const saved=(await (await page.request.get(workUrl)).json()).work;
  assert.equal(saved.items.find((value:{id:string})=>value.id===item.id).dueDate,"2026-10-15");
  assert.equal(saved.items.find((value:{id:string})=>value.id===item.id).status,"in_progress");
  await page.reload();
  await page.getByRole("button",{name:engagement.title,exact:true}).click();
  await page.getByText("Review notes persist across refresh.",{exact:false}).waitFor();
  assert.deepEqual(errors,[]);
  await page.locator(".engagement-work").scrollIntoViewIfNeeded();
  await page.screenshot({path:"work/browser/engagement-work.png"});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:"work/browser/engagement-work-mobile.png"});
  console.log("PASS: work HTTP updates/conflicts, notes, attachment bytes and headers, unsafe link rejection, engagement UI persisted data.");
} catch(error) {
  const page=browser.contexts()[0]?.pages()[0];
  if(page) {
    await page.screenshot({path:"work/browser/engagement-work-failure.png"}).catch(()=>{});
    console.log((await page.locator("body").innerText()).slice(0,1800));
  }
  throw error;
} finally {
  await browser.close();
  if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await harness.dispose();
}



