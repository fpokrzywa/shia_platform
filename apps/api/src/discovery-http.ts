import type {Actor} from '../../../packages/persistence/src/workspace/types.js';
import {DiscoveryOutcomeService} from '../../../packages/persistence/src/workspace/discovery.js';
import {PortfolioService} from '../../../packages/persistence/src/workspace/portfolio.js';
import {ValidationError,NotFoundError} from '../../../packages/persistence/src/workspace/errors.js';
import type {ClientPool} from '../../../packages/persistence/src/index.js';
export async function discoveryRequest(pool:ClientPool,actor:Actor,pathname:string,method:string,body:Record<string,unknown>){
 if(pathname==='/api/portfolio'&&method==='GET')return {status:200,body:{engagements:await new PortfolioService(pool).list(actor)}};
 const r=/^\/api\/engagements\/([a-zA-Z0-9-]+)\/discovery(?:\/(sessions|use-cases|assumptions|approaches|metrics|scope)(?:\/([a-zA-Z0-9-]+)(\/observations)?)?)?$/.exec(pathname);if(!r)return null;
 const [,eid,collection,id,observations]=r;const service=new DiscoveryOutcomeService(pool);
 if(method==='GET'&&!collection)return {status:200,body:{discovery:await service.get(actor,eid!)}};
 if(method!=='POST'||!collection)throw new NotFoundError('Discovery action not found');
 const str=(k:string,max=20000)=>{const v=body[k];if(typeof v!=='string'||!v.trim()||v.length>max)throw new ValidationError(`${k} must contain 1 to ${max} characters`);return v;};const opt=(k:string)=>body[k]==null?{}:{[k]:str(k)};
 const num=(k:string)=>{const v=body[k];if(typeof v!=='number'||!Number.isFinite(v))throw new ValidationError(`${k} must be a number`);return v;};const optionalNum=(k:string)=>body[k]==null?{}:{[k]:num(k)};
 const revision=()=>{const v=num('expectedRevision');if(!Number.isSafeInteger(v)||v<1)throw new ValidationError('Expected revision must be positive');return v;};const base={requestKey:str('requestKey',200)};let record:unknown;
 if(collection==='scope'&&!id){const v=num('expectedRevision');if(!Number.isSafeInteger(v)||v<0)throw new ValidationError('Scope link revision must be nonnegative');record=await service.linkAcceptedScope(actor,eid!,{...base,expectedRevision:v,scopeId:str('scopeId',200)});}
 else if(collection==='metrics'&&id&&observations)record=await service.addOutcomeObservation(actor,eid!,id,{...base,observedOn:str('observedOn',10),value:num('value'),...opt('note'),...opt('evidenceId')});
 else if(observations)throw new NotFoundError('Discovery action not found');
 else if(collection==='sessions'){const participants=body.participantUserIds;if(!Array.isArray(participants)||participants.length>100||participants.some(x=>typeof x!=='string'))throw new ValidationError('Participants must be a list of user IDs');const input={...base,purpose:str('purpose',5000),sessionDate:str('sessionDate',10),summary:str('summary'),participantUserIds:participants as string[]};record=id?await service.updateSession(actor,eid!,id,{...input,expectedRevision:revision()}):await service.createSession(actor,eid!,input);}
 else if(collection==='use-cases'){const input={...base,title:str('title',300),problemStatement:str('problemStatement',10000),actor:str('actor',2000),desiredOutcome:str('desiredOutcome',10000)};record=id?await service.updateUseCase(actor,eid!,id,{...input,expectedRevision:revision()}):await service.createUseCase(actor,eid!,input);}
 else if(collection==='assumptions'){const input={...base,statement:str('statement',10000),status:str('status'),...opt('rationale')};record=id?await service.updateAssumption(actor,eid!,id,{...input,expectedRevision:revision()}):await service.createAssumption(actor,eid!,input);}
 else if(collection==='approaches'){let effort:{value:number;unit:string}|undefined;if(body.effort!=null){const e=body.effort as Record<string,unknown>;if(typeof e.value!=='number'||!Number.isFinite(e.value)||typeof e.unit!=='string'||!e.unit.trim()||e.unit.length>100)throw new ValidationError('Effort requires a value and unit');effort={value:e.value,unit:e.unit};}const input={...base,title:str('title',300),description:str('description'),status:str('status'),...opt('rationale'),...(effort?{effort}:{})};record=id?await service.updateApproach(actor,eid!,id,{...input,expectedRevision:revision()}):await service.createApproach(actor,eid!,input);}
 else if(collection==='metrics'){const input={...base,name:str('name',300),unit:str('unit',100),...opt('description'),...optionalNum('baseline'),...optionalNum('target')};record=id?await service.updateOutcomeMetric(actor,eid!,id,{...input,expectedRevision:revision()}):await service.createOutcomeMetric(actor,eid!,input);}
 else throw new NotFoundError('Discovery action not found');
 return {status:id||collection==='scope'?200:201,body:{record}};
}
