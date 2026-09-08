import assert from "node:assert/strict";
import test from "node:test";
import type {ClientPool} from "../database.js";
import {ConflictError} from "./errors.js";
import {TemplateService} from "./templates.js";

function pool(options:{referenced?:boolean;archived?:boolean}={}){
  const calls:Array<{sql:string;values?:unknown[]}>=[];
  const client={async query(sql:string,values?:unknown[]){calls.push(values?{sql,values}:{sql});if(sql.startsWith("SELECT input_hash"))return{rows:[]};if(sql.startsWith("SELECT template_key"))return{rows:[{template_key:"delivery",management_revision:"1",archived_at:options.archived?new Date():null}]};if(sql.startsWith("SELECT 1 FROM workspace_engagements"))return{rows:options.referenced?[{exists:1}]:[],rowCount:options.referenced?1:0};if(sql.startsWith("UPDATE workspace_templates"))return{rows:[{management_revision:"2"}]};return{rows:[],rowCount:0};},release(){}};
  return{calls,pool:{connect:async()=>client,query:client.query,end:async()=>{}} as unknown as ClientPool};
}

const admin={id:"admin-1",role:"practice_admin" as const};

test("archives an unused template without changing any version",async()=>{const fixture=pool();const result=await new TemplateService(fixture.pool).setArchived(admin,{templateKey:"delivery",archived:true,expectedRevision:1,requestKey:"archive-1"});assert.deepEqual(result,{templateKey:"delivery",archived:true,managementRevision:2});assert.equal(fixture.calls.some(call=>call.sql.includes("workspace_template_versions")),false);assert.equal(fixture.calls.some(call=>call.values?.includes("template.archive")),true);});

test("refuses to archive a template referenced by any engagement",async()=>{const fixture=pool({referenced:true});await assert.rejects(()=>new TemplateService(fixture.pool).setArchived(admin,{templateKey:"delivery",archived:true,expectedRevision:1,requestKey:"archive-1"}),ConflictError);assert.equal(fixture.calls.some(call=>call.sql.startsWith("UPDATE workspace_templates")),false);assert.equal(fixture.calls.at(-1)?.sql,"ROLLBACK");});

test("restores an archived template with optimistic revision",async()=>{const fixture=pool({archived:true});const result=await new TemplateService(fixture.pool).setArchived(admin,{templateKey:"delivery",archived:false,expectedRevision:1,requestKey:"restore-1"});assert.deepEqual(result,{templateKey:"delivery",archived:false,managementRevision:2});assert.equal(fixture.calls.some(call=>call.values?.includes("template.restore")),true);});
