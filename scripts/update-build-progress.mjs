import {open,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
const [itemId,status,...detailParts]=process.argv.slice(2),detail=detailParts.join(' ').trim();
if(!itemId||!['building','testing','ready','blocked','planned'].includes(status)||!detail)throw Error('Usage: update-build-progress.mjs <item-id> <status> <verified detail>');
const file=new URL('../docs/build-progress.json',import.meta.url),lock=new URL('../docs/build-progress.lock',import.meta.url),temporary=new URL(`../docs/build-progress.${process.pid}.tmp`,import.meta.url);let handle;
for(let attempt=0;attempt<60;attempt++){try{handle=await open(lock,'wx');break}catch(error){if(error.code!=='EEXIST')throw error;await pause(50)}}
if(!handle)throw Error('Progress update is locked; retry shortly.');
try{const data=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));const item=data.items.find(x=>x.id===itemId);if(!item)throw Error('Unknown build item');item.status=status;item.detail=detail;data.updatedAt=new Date().toISOString();data.focus=`Latest verification — ${item.title}: ${detail}`;await writeFile(temporary,JSON.stringify(data,null,2),'utf8');await rename(temporary,file);console.log(`Updated ${item.title}: ${status}`)}finally{await handle.close();await unlink(lock);await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
