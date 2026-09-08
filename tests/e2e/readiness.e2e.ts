import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { createPostgresHarness } from "../integration/postgres-harness.js";
import { runMigrations,readMigrationFiles } from "../../packages/persistence/src/migrations.js";
import { bootstrapPracticeAdmin } from "../../apps/api/src/auth/bootstrap.js";
import { createApiServer } from "../../apps/api/src/server.js";
const browser=await chromium.launch();
const harness=await createPostgresHarness().catch(async error=>{await browser.close();throw error;});
const server=createApiServer({pool:harness.pool});
try{
 await runMigrations(harness.pool,await readMigrationFiles("migrations"));
 const password=randomBytes(24).toString("base64url");
 await bootstrapPracticeAdmin(harness.pool,{email:"readiness-review@example.test",displayName:"Readiness Reviewer",password});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();assert(address&&typeof address!=="string");
 const base=`http://127.0.0.1:${address.port}`;
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(15000);
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 await page.goto(base);await page.getByLabel("Email",{exact:true}).fill("readiness-review@example.test");await page.getByLabel("Password",{exact:true}).fill(password);await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.getByRole("button",{name:"Sample data",exact:true}).waitFor();
 assert.equal((await page.request.post(base+"/api/samples/load",{data:{expectedRevision:0,requestKey:randomUUID(),confirmation:"load-sample-data"}})).status(),200);
 const engagement=(await (await page.request.get(base+"/api/engagements")).json()).engagements.find((e:{title:string})=>e.title.includes("apprenticeship"));
 const root=`${base}/api/engagements/${engagement.id}`;
 const getStage=async()=> (await (await page.request.get(root+"/readiness")).json()).readiness.stages.find((s:{definitionKey:string})=>s.definitionKey==="pre-camp-preparation");
 let stage=await getStage();assert(stage.canReview);assert(stage.blockers.length>0);
 const fail=await page.request.post(`${root}/readiness/stages/${stage.stageId}/decisions`,{data:{requestKey:randomUUID(),expectedToken:stage.token,decision:"go",rationale:"Cannot proceed with missing preparation."}});assert.equal(fail.status(),422);
 const staleToken=stage.token;
 let work=(await (await page.request.get(root+"/work")).json()).work;
 for(const item of work.items.filter((i:{stageId:string})=>i.stageId===stage.stageId)){
   if(item.name==="Stakeholder map")continue;
   for(const key of item.evidenceRequirementKeys??[]){
     assert.equal((await page.request.post(root+"/work/evidence",{data:{requestKey:randomUUID(),itemId:item.id,title:"Reviewed preparation evidence",url:"https://example.test/preparation",evidenceRequirementKey:key}})).status(),201);
   }
   assert.equal((await page.request.post(`${root}/work/items/${item.id}`,{data:{requestKey:randomUUID(),expectedRevision:item.revision,status:"complete"}})).status(),200);
 }
 stage=await getStage();
 assert.equal((await page.request.post(`${root}/readiness/stages/${stage.stageId}/decisions`,{data:{requestKey:randomUUID(),expectedToken:staleToken,decision:"no_go",rationale:"Stale review must conflict."}})).status(),409);
 const actorId=(await harness.pool.query("SELECT id FROM app_users WHERE email='readiness-review@example.test'")).rows[0].id;
 const waiver=stage.waivableItems.find((i:{name:string})=>i.name==="Stakeholder map");assert(waiver);
 const due=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
 const conditional=await page.request.post(`${root}/readiness/stages/${stage.stageId}/decisions`,{data:{requestKey:randomUUID(),expectedToken:stage.token,decision:"conditional_go",rationale:"Proceed with owned stakeholder follow-up.",exceptions:[{itemId:waiver.itemId,ownerUserId:actorId,dueDate:due,rationale:"Confirm remaining stakeholder details."}]}});
 assert.equal(conditional.status(),201);
 stage=await getStage();assert.equal(stage.latestDecision.decision,"conditional_go");assert.equal(stage.latestDecision.effective,true);
 await page.reload();await page.getByRole("button",{name:engagement.title,exact:true}).click();
 await page.getByRole("heading",{name:"Readiness review",exact:true}).waitFor();
 await page.locator(".readiness-panel:not([hidden]) .decision-history summary").click();
 await page.getByText("Proceed with owned stakeholder follow-up.",{exact:false}).first().waitFor();
 const panel=page.locator(".readiness-panel:not([hidden])");
 await panel.getByLabel("Decision",{exact:true}).selectOption("reopen");
 await panel.getByLabel("Decision rationale",{exact:true}).fill("Reopen to revise the preparation plan.");
 await panel.getByRole("button",{name:"Reopen readiness",exact:true}).click();
 await page.getByText("Pre-camp preparation readiness was reopened.",{exact:true}).waitFor();
 stage=await getStage();assert.equal(stage.latestDecision?.effective??false,false);
 const templates=(await (await page.request.get(base+"/api/templates")).json()).templates;
 const template=templates.find((t:{templateKey:string})=>t.templateKey===engagement.templateKey);
 assert.equal((await page.request.post(base+"/api/templates/archive",{data:{templateKey:template.templateKey,expectedRevision:template.managementRevision,requestKey:randomUUID()}})).status(),409);
 const sample=(await (await page.request.get(base+"/api/samples")).json()).sample;
 assert.equal((await page.request.post(base+"/api/samples/remove",{data:{expectedRevision:sample.revision,requestKey:randomUUID(),confirmation:"remove-sample-data"}})).status(),200);
 await page.getByRole("button",{name:"Templates",exact:true}).click();
 await page.getByRole("button",{name:/^Sample templates/}).click();
 await page.getByRole("button").filter({has:page.getByRole("heading",{name:template.definition.name,exact:true})}).click();
 await page.getByRole("button",{name:"Archive template",exact:true}).click();
 await page.getByRole("button",{name:"Archived (1)",exact:true}).waitFor();
 await page.getByRole("button",{name:"Archived (1)",exact:true}).click();
 await page.getByRole("button").filter({has:page.getByRole("heading",{name:template.definition.name,exact:true})}).click();
 await page.getByRole("button",{name:"Restore template",exact:true}).click();
 await page.getByRole("button",{name:"Archived (0)",exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log("PASS: readiness missing-prerequisite block, classified evidence, stale-token rejection, conditional exception, effective history and browser view.");
} catch(error){const page=browser.contexts()[0]?.pages()[0];if(page){await page.screenshot({path:"work/browser/readiness-failure.png"}).catch(()=>{});console.log((await page.locator("body").innerText()).slice(-2500));}throw error;}
finally{await browser.close();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await harness.dispose();}
