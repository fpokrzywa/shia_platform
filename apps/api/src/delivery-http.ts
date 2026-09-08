import type { Actor } from '../../../packages/persistence/src/workspace/types.js';
import { DeliveryService } from '../../../packages/persistence/src/workspace/delivery.js';
import { ValidationError, NotFoundError } from '../../../packages/persistence/src/workspace/errors.js';
import type { ClientPool } from '../../../packages/persistence/src/index.js';

export async function deliveryRequest(pool:ClientPool,actor:Actor,pathname:string,method:string,body:Record<string,unknown>):Promise<{status:number;body:unknown}|null>{
 const route=/^\/api\/engagements\/([a-zA-Z0-9-]+)\/delivery(?:\/(scopes|milestones|risks|decisions|deliverables|acceptance|followups)(?:\/([a-zA-Z0-9-]+)(\/decision)?)?)?$/.exec(pathname);
 if(!route)return null;
 const [,engagementId,collection,recordId,decision]=route;const service=new DeliveryService(pool);const id=engagementId!;
 if(method==='GET'&&!collection)return {status:200,body:{delivery:await service.get(actor,id)}};
 if(method!=='POST'||!collection)throw new NotFoundError('Delivery action not found');
 const str=(key:string,max=10000):string=>{const v=body[key];if(typeof v!=='string'||!v.trim()||v.length>max)throw new ValidationError(`${key} must contain 1 to ${max} characters`);return v;};
 const optional=(key:string)=>body[key]===undefined?{}:{[key]:str(key)};
 const nullable=(key:string)=>body[key]===undefined?{}:{[key]:body[key]===null?null:str(key)};
 const strings=(key:string):string[]=>{const v=body[key];if(!Array.isArray(v)||v.length>100||v.some(x=>typeof x!=='string'||!x.trim()||x.length>1000))throw new ValidationError(`${key} must be a list of up to 100 text entries`);return v as string[];};
 const base={requestKey:str('requestKey',200)};
 const revision=()=>{const v=body.expectedRevision;if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1)throw new ValidationError('Expected revision must be positive');return v;};
 let result:unknown;
 if(collection==='scopes'&&recordId&&decision)result=await service.decideScope(actor,id,recordId,{...base,expectedRevision:revision(),decision:str('decision'),rationale:str('rationale'),...optional('evidenceId')});
 else if(recordId&&!decision){const update={...base,expectedRevision:revision(),status:str('status'),...optional('title')};switch(collection){
 case 'milestones':result=await service.updateMilestone(actor,id,recordId,{...update,...nullable('ownerUserId'),...nullable('dueDate')});break;
 case 'risks':result=await service.updateRisk(actor,id,recordId,{...update,...optional('severity'),...optional('mitigation'),...nullable('ownerUserId')});break;
 case 'deliverables':result=await service.updateDeliverable(actor,id,recordId,{...update,...optional('description')});break;
 case 'followups':result=await service.updateFollowup(actor,id,recordId,{...update,...nullable('ownerUserId'),...nullable('dueDate')});break;
 default:throw new NotFoundError('Delivery action not found');}}
 else if(!recordId){switch(collection){
 case 'scopes':result=await service.proposeScope(actor,id,{...base,commitments:strings('commitments'),exclusions:strings('exclusions'),estimate:str('estimate',2000),acceptanceCriteria:strings('acceptanceCriteria')});break;
 case 'milestones':result=await service.createMilestone(actor,id,{...base,title:str('title',300),...nullable('ownerUserId'),...nullable('dueDate')});break;
 case 'risks':result=await service.createRisk(actor,id,{...base,title:str('title',300),severity:str('severity'),mitigation:str('mitigation'),...nullable('ownerUserId')});break;
 case 'decisions':result=await service.addDecision(actor,id,{...base,title:str('title',300),decision:str('decision'),rationale:str('rationale')});break;
 case 'deliverables':result=await service.createDeliverable(actor,id,{...base,title:str('title',300),description:str('description')});break;
 case 'acceptance':result=await service.recordAcceptance(actor,id,{...base,result:str('result'),rationale:str('rationale'),sourceType:str('sourceType'),...optional('deliverableId'),...optional('evidenceId'),...optional('externalName')});break;
 case 'followups':result=await service.createFollowup(actor,id,{...base,title:str('title',300),...nullable('ownerUserId'),...nullable('dueDate')});break;
 default:throw new NotFoundError('Delivery action not found');}}
 else throw new NotFoundError('Delivery action not found');
 return {status:recordId?200:201,body:{record:result}};
}
