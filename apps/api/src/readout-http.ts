import type { Actor } from '../../../packages/persistence/src/workspace/types.js';
import { FinalReadoutService } from '../../../packages/persistence/src/workspace/readouts.js';
import { ValidationError, NotFoundError } from '../../../packages/persistence/src/workspace/errors.js';
import type { ClientPool } from '../../../packages/persistence/src/index.js';
export async function readoutRequest(pool:ClientPool,actor:Actor,pathname:string,method:string,body:Record<string,unknown>){
 const route=/^\/api\/engagements\/([a-zA-Z0-9-]+)\/readouts(?:\/([a-zA-Z0-9-]+)(?:\/(review|markdown|json))?)?$/.exec(pathname);if(!route)return null;
 const [,engagementId,readoutId,action]=route;const service=new FinalReadoutService(pool);const id=engagementId!;
 if(method==='GET'){
 if(!readoutId)return {status:200,body:{readouts:await service.list(actor,id)}};
 if(!action)return {status:200,body:{readout:await service.get(actor,id,readoutId)}};
 if(action==='markdown'||action==='json')return {status:200,download:await service.export(actor,id,readoutId,{format:action})};
 }
 const str=(key:string,max=10000)=>{const v=body[key];if(typeof v!=='string'||!v.trim()||v.length>max)throw new ValidationError(`${key} is required and must be at most ${max} characters`);return v;};
 if(method==='POST'&&!readoutId)return {status:201,body:{readout:await service.generate(actor,id,{requestKey:str('requestKey',200),title:str('title',300)})}};
 if(method==='POST'&&readoutId&&action==='review'){
 const expectedRevision=body.expectedRevision;if(typeof expectedRevision!=='number'||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new ValidationError('Expected revision must be positive');
 const decision=str('decision');if(decision!=='approved'&&decision!=='rejected')throw new ValidationError('Choose approved or rejected');
 return {status:200,body:{readout:await service.review(actor,id,readoutId,{requestKey:str('requestKey',200),expectedRevision,decision,rationale:str('rationale')})}};
 }
 throw new NotFoundError('Readout action not found');
}
