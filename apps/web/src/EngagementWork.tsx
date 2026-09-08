import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type EngagementDetail, type Member } from "./api";

type WorkStatus = "not_started" | "in_progress" | "blocked" | "ready_for_review" | "complete" | "not_applicable";
type WorkItem = { id:string; stageId:string; name:string; status:WorkStatus; revision:number; ownerUserId:string|null; dueDate:string|null; required:boolean; evidenceRequirementKeys:string[]; evidenceRequirements:{key:string;name:string}[] };
type WorkNote = { id:string; engagementId:string; itemId:string|null; actorId:string; text:string; createdAt:string };
type WorkEvidence = { id:string; engagementId:string; itemId:string; title:string; url?:string; fileName?:string; suppliedMediaType?:string; hasAttachment:boolean; size:number; recordedBy:string; createdAt:string; evidenceRequirementKey?:string };
type Work = { items:WorkItem[]; notes:WorkNote[]; evidence:WorkEvidence[] };

const statuses: WorkStatus[] = ["not_started", "in_progress", "blocked", "ready_for_review", "complete"];
const statusLabel:Record<WorkStatus,string>={not_started:"Not started",in_progress:"In progress",blocked:"Blocked",ready_for_review:"Needs review",complete:"Done",not_applicable:"Not applicable"};
const dueLabel=(value:string|null)=>value?new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(new Date(`${value}T00:00:00`)):"No due date";
const errorMessage = (error:unknown) => error instanceof Error ? error.message : "The request failed. Please try again.";
const fields = (event:FormEvent<HTMLFormElement>) => { event.preventDefault(); return Object.fromEntries(new FormData(event.currentTarget).entries()); };

function fileBase64(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error("The attachment could not be read."));reader.onload=()=>resolve(String(reader.result).split(",",2)[1]??"");reader.readAsDataURL(file);});
}

export function EngagementWork({engagementId}:{engagementId:string}){
  const [detail,setDetail]=useState<EngagementDetail|null>(null);
  const [members,setMembers]=useState<Member[]>([]);
  const [work,setWork]=useState<Work|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const [selectedStageId,setSelectedStageId]=useState<string|null>(null);
  const [dirtyItems,setDirtyItems]=useState(()=>new Set<string>());
  const [formVersion,setFormVersion]=useState(0);
  const [requestKeys]=useState(()=>new Map<string,string>());

  async function refresh(options:{resetForms?:boolean;clearNotice?:boolean}={}){
    const [detailResult,membersResult,workResult]=await Promise.all([
      api<{engagement:EngagementDetail}>(`/api/engagements/${encodeURIComponent(engagementId)}`),
      api<{members:Member[]}>(`/api/engagements/${encodeURIComponent(engagementId)}/members`),
      api<{work:Work}>(`/api/engagements/${encodeURIComponent(engagementId)}/work`),
    ]);
    setDetail(detailResult.engagement);setMembers(membersResult.members);setWork(workResult.work);setError("");
    setSelectedStageId(current=>current&&detailResult.engagement.stages.some(stage=>stage.id===current)?current:detailResult.engagement.stages.find(stage=>workResult.work.items.some(item=>item.stageId===stage.id&&item.status!=="complete"))?.id??detailResult.engagement.stages[0]?.id??null);
    if(options.resetForms){setFormVersion(value=>value+1);requestKeys.clear();setDirtyItems(new Set());}
    if(options.clearNotice)setNotice("");
  }
  useEffect(()=>{refresh({resetForms:true,clearNotice:true}).catch(error=>setError(errorMessage(error)));},[engagementId]);
  useEffect(()=>{const changed=(event:Event)=>{const detail=(event as CustomEvent<{engagementId:string;source?:string}>).detail;if(detail?.engagementId===engagementId&&detail.source!=="work")void refresh().catch(error=>setError(errorMessage(error)));};window.addEventListener("shi:engagement-work-changed",changed);return()=>window.removeEventListener("shi:engagement-work-changed",changed);},[engagementId]);

  async function mutate<T>(url:string,payload:Record<string,unknown>,success:string):Promise<T|undefined>{
    const intent=JSON.stringify([url,payload]);let requestKey=requestKeys.get(intent);
    if(!requestKey){requestKey=crypto.randomUUID();requestKeys.set(intent,requestKey);}
    setBusy(true);setError("");setNotice("");
    try{
      const result=await api<T>(url,{...payload,requestKey});
      await refresh();requestKeys.delete(intent);setNotice(success);window.dispatchEvent(new CustomEvent("shi:engagement-work-changed",{detail:{engagementId,source:"work"}}));return result;
    }catch(error){setError(errorMessage(error));if(error instanceof ApiError&&error.status===409)setNotice("The engagement changed. Refresh before trying again.");return undefined;}
    finally{setBusy(false);}
  }

  async function saveItem(event:FormEvent<HTMLFormElement>,item:WorkItem){
    const ownerControl=event.currentTarget.elements.namedItem("ownerUserId") as HTMLSelectElement;const data=fields(event);
    const selectedOwner=ownerControl.value;const payload:Record<string,unknown>={expectedRevision:item.revision,status:data.status,dueDate:data.dueDate||null};
    if(selectedOwner!==(item.ownerUserId??""))payload.ownerUserId=selectedOwner||null;
    const result=await mutate(`/api/engagements/${encodeURIComponent(engagementId)}/work/items/${encodeURIComponent(item.id)}`,payload,`${item.name} was updated.`);
    if(result)setDirtyItems(current=>{const next=new Set(current);next.delete(item.id);return next;});
  }
  async function toggleComplete(item:WorkItem){await mutate(`/api/engagements/${encodeURIComponent(engagementId)}/work/items/${encodeURIComponent(item.id)}`,{expectedRevision:item.revision,status:item.status==="complete"?"in_progress":"complete"},item.status==="complete"?`${item.name} reopened.`:`${item.name} marked done.`);}
  async function addNote(event:FormEvent<HTMLFormElement>,itemId?:string){const form=event.currentTarget;const data=fields(event);const result=await mutate(`/api/engagements/${encodeURIComponent(engagementId)}/work/notes`,{text:data.text,...(itemId?{itemId}:{})},"Note added.");if(result)form.reset();}
  async function addEvidence(event:FormEvent<HTMLFormElement>,itemId:string){
    const form=event.currentTarget;const data=fields(event);const file=(data.file instanceof File&&data.file.size>0)?data.file:null;const url=String(data.url??"").trim();setBusy(true);setError("");
    if((file?1:0)+(url?1:0)!==1){setError("Provide one evidence link or one attachment.");setBusy(false);return;}
    if(file&&file.size>2*1024*1024){setError("Attachments must be 2 MiB or smaller.");setBusy(false);return;}
    const payload:Record<string,unknown>={itemId,title:data.title};if(data.evidenceRequirementKey)payload.evidenceRequirementKey=data.evidenceRequirementKey;
    if(file){try{payload.fileName=file.name;payload.mediaType=file.type||"application/octet-stream";payload.base64=await fileBase64(file);}catch(error){setError(errorMessage(error));setBusy(false);return;}}else payload.url=url;
    const result=await mutate(`/api/engagements/${encodeURIComponent(engagementId)}/work/evidence`,payload,"Evidence added.");if(result)form.reset();
  }

  if(!detail||!work)return <section><h2>Engagement work</h2>{error?<p className="error" role="alert">{error} <button onClick={()=>void refresh({resetForms:true}).catch(e=>setError(errorMessage(e)))}>Try again</button></p>:<p>Loading checklist work…</p>}</section>;
  const memberName=(id:string|null)=>id?members.find(member=>member.userId===id)?.displayName??"Recorded participant":"Unassigned";
  const owners=Array.from(new Map(members.map(member=>[member.userId,member])).values());
  const completeCount=work.items.filter(item=>item.status==="complete").length;
  return <div className="engagement-work" key={formVersion}>
    <div className="section-heading work-overview"><div><h2>Checklist work</h2><p><strong>{completeCount} of {work.items.length}</strong> checklist items done. This count does not approve or complete a stage.</p></div><div className="work-overview-actions"><a href="#engagement-notes">Engagement notes</a><button disabled={busy} onClick={()=>void refresh({resetForms:true,clearNotice:true}).catch(e=>setError(errorMessage(e)))}>Refresh</button></div></div>
    {error&&<p className="error" role="alert">{error} {notice&&<button onClick={()=>void refresh({resetForms:true,clearNotice:true}).catch(e=>setError(errorMessage(e)))}>Refresh now</button>}</p>}
    {notice&&!error&&<p className="notice" role="status">{notice}</p>}
    <nav className="stage-switcher" aria-label="Engagement stages">{detail.stages.map((stage,index)=>{const items=work.items.filter(item=>item.stageId===stage.id);const done=items.filter(item=>item.status==="complete").length;return <button type="button" key={stage.id} className={selectedStageId===stage.id?"selected":undefined} aria-pressed={selectedStageId===stage.id} onClick={()=>setSelectedStageId(stage.id)}><span>{index+1}. {stage.name}</span><small>{done}/{items.length} done</small></button>;})}</nav>
    <div className="stage-panels">{detail.stages.map(stage=>{const items=work.items.filter(item=>item.stageId===stage.id);return <section className="work-stage" key={stage.id} hidden={selectedStageId!==stage.id} aria-labelledby={`stage-${stage.id}`}><div className="work-stage-title"><div><h3 id={`stage-${stage.id}`}>{stage.name}</h3><p>{items.filter(item=>item.status==="complete").length} of {items.length} checklist items done · Stage status: {stage.state.replaceAll("_"," ")}</p></div></div>{items.length===0?<p>No checklist items in this stage.</p>:<div className="task-list">{items.map(item=>{const noteCount=work.notes.filter(note=>note.itemId===item.id).length;const evidenceCount=work.evidence.filter(evidence=>evidence.itemId===item.id).length;const isDone=item.status==="complete";const isDirty=dirtyItems.has(item.id);const dirtyHint=`dirty-${item.id}`;return <article className={`work-item${isDone?" is-done":""}`} key={item.id}><div className="task-row"><input type="checkbox" checked={isDone} disabled={busy||isDirty} aria-describedby={isDirty?dirtyHint:undefined} aria-label={isDone?`Reopen ${item.name}`:`Mark ${item.name} complete`} onChange={()=>void toggleComplete(item)}/><div className="task-main"><h4>{item.name}</h4><p>{memberName(item.ownerUserId)}<span aria-hidden="true"> · </span>{item.dueDate?`Due ${dueLabel(item.dueDate)}`:dueLabel(null)}</p>{isDirty&&<p className="task-save-hint" id={dirtyHint}>Save changes before using the completion shortcut.</p>}</div><span className={`task-status status-${item.status}`}>{statusLabel[item.status]}</span><span className="task-counts">{noteCount} {noteCount===1?"note":"notes"}<br/>{evidenceCount} evidence</span></div>
      <details className="task-details"><summary>Details for {item.name}</summary><div className="task-detail-body"><form key={item.revision} className="work-item-form" onChange={()=>setDirtyItems(current=>new Set(current).add(item.id))} onSubmit={event=>void saveItem(event,item)}><label>Status<select aria-label={`Status for ${item.name}`} name="status" defaultValue={item.status} disabled={busy}>{item.status==="not_applicable"&&<option value="not_applicable" disabled>Not applicable (reviewed)</option>}{statuses.map(status=><option key={status} value={status}>{statusLabel[status]}</option>)}</select></label><label>Owner<select aria-label={`Owner for ${item.name}`} name="ownerUserId" defaultValue={item.ownerUserId??""} disabled={busy}><option value="">Unassigned</option>{item.ownerUserId&&!owners.some(member=>member.userId===item.ownerUserId)&&<option value={item.ownerUserId} disabled>Former team member — reassign when ready</option>}{owners.map(member=><option key={member.userId} value={member.userId}>{member.displayName??member.email??member.userId}</option>)}</select></label><label>Due date<input aria-label={`Due date for ${item.name}`} type="date" name="dueDate" defaultValue={item.dueDate??""} disabled={busy}/></label><button disabled={busy}>Save changes</button></form>
      <div className="work-support"><div><h5>Notes</h5>{work.notes.filter(note=>note.itemId===item.id).map(note=><p className="work-entry" key={note.id}>{note.text}<small>{memberName(note.actorId)} · {new Date(note.createdAt).toLocaleString()}</small></p>)}<form onSubmit={event=>void addNote(event,item.id)}><label>Add item note<textarea name="text" required maxLength={4000} disabled={busy}/></label><button disabled={busy}>Add note</button></form></div>
      <div><h5>Evidence</h5>{work.evidence.filter(evidence=>evidence.itemId===item.id).map(evidence=><p className="work-entry" key={evidence.id}><strong>{evidence.title}</strong>{evidence.evidenceRequirementKey&&<span>{item.evidenceRequirements.find(requirement=>requirement.key===evidence.evidenceRequirementKey)?.name??evidence.evidenceRequirementKey}</span>}{evidence.url?<a href={evidence.url} target="_blank" rel="noreferrer">Open link</a>:evidence.hasAttachment?<a href={`/api/engagements/${encodeURIComponent(engagementId)}/work/evidence/${encodeURIComponent(evidence.id)}/download`}>Download {evidence.fileName??"attachment"}</a>:null}<small>{memberName(evidence.recordedBy)} · {new Date(evidence.createdAt).toLocaleString()}</small></p>)}<form onSubmit={event=>void addEvidence(event,item.id)}><label>Evidence title<input name="title" required maxLength={200} disabled={busy}/></label>{item.evidenceRequirements.length>0&&<label>Evidence requirement<select name="evidenceRequirementKey" defaultValue="" disabled={busy}><option value="">Unclassified supporting evidence</option>{item.evidenceRequirements.map(requirement=><option key={requirement.key} value={requirement.key}>{requirement.name}</option>)}</select></label>}<label>Link<input name="url" type="url" maxLength={2000} placeholder="https://…" disabled={busy}/></label><label>Or attachment<input name="file" type="file" disabled={busy}/></label><p className="help">Choose one link or one file, up to 2 MiB. Select a requirement when this evidence fulfills it.</p><button disabled={busy}>Add evidence</button></form></div></div></div></details>
    </article>})}</div>}</section>})}</div>
    <section className="running-notes" id="engagement-notes"><h3>Engagement notes</h3><p>Keep a running journal for context that applies across stages.</p>{work.notes.filter(note=>note.itemId===null).map(note=><p className="work-entry" key={note.id}>{note.text}<small>{memberName(note.actorId)} · {new Date(note.createdAt).toLocaleString()}</small></p>)}<form onSubmit={event=>void addNote(event)}><label>Add engagement note<textarea name="text" required maxLength={4000} disabled={busy}/></label><button disabled={busy}>Add note</button></form></section>
  </div>;
}

