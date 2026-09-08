import type {Actor} from '../../../packages/persistence/src/workspace/types.js';
import {KnowledgeService,type KnowledgeKind,type KnowledgeSourceRef} from '../../../packages/persistence/src/workspace/knowledge.js';
import {ValidationError,NotFoundError} from '../../../packages/persistence/src/workspace/errors.js';
import type {ClientPool} from '../../../packages/persistence/src/index.js';
export async function knowledgeRequest(pool:ClientPool,actor:Actor,pathname:string,method:string,body:Record<string,unknown>){
 const service=new KnowledgeService(pool);
 const str=(k:string,max=10000)=>{const v=body[k];if(typeof v!=='string'||!v.trim()||v.length>max)throw new ValidationError(`${k} must contain 1 to ${max} characters`);return v;};const opt=(k:string,max=10000)=>body[k]===undefined?{}:{[k]:str(k,max)};const revision=()=>{const v=body.expectedRevision;if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1)throw new ValidationError('Expected revision must be positive');return v;};
 const refs=()=>{const v=body.sourceRefs;if(!Array.isArray(v)||v.length>100||v.some(x=>!x||typeof x!=='object'||typeof x.title!=='string'||typeof x.url!=='string'))throw new ValidationError('Provide a list of source titles and URLs');return v as KnowledgeSourceRef[];};
 const content=()=>{const kind=str('kind');if(!['recipe','discovery_guide','architecture_pattern'].includes(kind))throw new ValidationError('Choose a supported knowledge type');return {requestKey:str('requestKey',200),key:str('key',200),kind:kind as KnowledgeKind,title:str('title',300),summary:str('summary',5000),body:str('body',50000),...(body.sourceRefs===undefined?{}:{sourceRefs:refs()})};};
 if(pathname==='/api/knowledge'){
 if(method==='GET')return {status:200,body:{versions:await service.list(actor,{includeDrafts:true})}};
 return {status:201,body:{version:await service.createDraft(actor,content())}};
 }
 const links=/^\/api\/engagements\/([a-zA-Z0-9-]+)\/knowledge(?:\/(submit))?$/.exec(pathname);
 if(links){const id=links[1]!;if(method==='GET'&&!links[2])return {status:200,body:{links:await service.listLinks(actor,id)}};
 if(method==='POST'&&links[2]){const source=body.source;if(!source||typeof source!=='object'||Array.isArray(source))throw new ValidationError('A source record is required');const v=source as Record<string,unknown>;if(!['note','learning_log'].includes(String(v.type))||typeof v.id!=='string')throw new ValidationError('Choose a note or learning log source');return {status:201,body:{version:await service.submitFromEngagement(actor,{...content(),engagementId:id,source:{type:v.type as 'note'|'learning_log',id:v.id}})}};}
 if(method==='POST'){const version=body.version;if(typeof version!=='number'||!Number.isSafeInteger(version)||version<1)throw new ValidationError('Version must be positive');return {status:201,body:{link:await service.link(actor,id,{requestKey:str('requestKey',200),key:str('key',200),version,rationale:str('rationale',5000)})}};}
 }
 const r=/^\/api\/knowledge\/([^/]+)\/([1-9][0-9]*)(?:\/(edit|versions|submit|publish|retire|archive|restore))?$/.exec(pathname);if(!r)return null;
 const key=decodeURIComponent(r[1]!);const version=Number(r[2]);if(!Number.isSafeInteger(version))throw new ValidationError('Invalid version');
 if(method==='GET'&&!r[3])return {status:200,body:{version:await service.getVersion(actor,key,version)}};
 if(method==='POST'){const base={requestKey:str('requestKey',200),expectedRevision:revision()};let record:unknown;
 if(r[3]==='edit'||r[3]==='versions'){const edits={...base,...opt('title',300),...opt('summary',5000),...opt('body',50000),...(body.sourceRefs===undefined?{}:{sourceRefs:refs()})};record=r[3]==='edit'?await service.updateDraft(actor,key,version,edits):await service.createVersion(actor,key,version,{...edits,rationale:str('rationale',5000)});}
 else if(r[3]==='submit')record=await service.submitForReview(actor,key,version,{...base,rationale:str('rationale',5000)});
 else if(r[3]==='publish')record=await service.publish(actor,key,version,{...base,rationale:str('rationale',5000)});
 else if(r[3]==='retire')record=await service.retire(actor,key,version,{...base,rationale:str('rationale',5000)});
 else if(r[3]==='archive'||r[3]==='restore')record=await service.setArchived(actor,key,{...base,archived:r[3]==='archive'});
 else throw new NotFoundError('Knowledge action not found');
 return {status:200,body:{record}};
 }
 throw new NotFoundError('Knowledge action not found');
}
