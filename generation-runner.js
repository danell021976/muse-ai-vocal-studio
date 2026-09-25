const fs=require('node:fs'),path=require('node:path');
function createRunner({credits,stores,replicate,download,pollDelay=3000}){
 let stopped=false;const running=new Set(),timers=new Set();
 const pause=()=>new Promise(resolve=>{const timer=setTimeout(()=>{timers.delete(timer);resolve();},pollDelay);timer.unref?.();timers.add(timer);});
 async function jobRun(batch,original){
  let job=credits.getJob(batch.user_id,original.id);
  if(['ready','failed','attention'].includes(job.state))return;
  if(job.state==='queued'){
   if(!replicate||!credits.claim(job.id))return;
   try{
    const result=await replicate.predictions.create({model:'minimax/music-2.6',input:JSON.parse(batch.payload).input});
    if(typeof result?.id!=='string'||!result.id)throw Error('Missing prediction ID');
    credits.prediction(job.id,result.id);
   }catch(error){
    // Only definite rejections can release the reservation automatically.
    if([400,401,402,403,404,422,429].includes(error.status))credits.settle(job.id,false,'Replicate rejected this request ('+error.status+'). Credits returned.');
    else credits.attention(job.id,'Submission could not be confirmed. Replicate may have accepted it. No automatic resubmission was made.');
    return;
   }
   job=credits.getJob(batch.user_id,job.id);
  }
  if(!replicate)return;
  const directory=stores.get({id:batch.user_id}).directory;
  const filename=path.join(directory,path.basename(job.url));
  while(!stopped){
   if(fs.existsSync(filename)&&fs.statSync(filename).size>0){credits.settle(job.id,true);return;}
   let result;
   try{result=await replicate.predictions.get(job.prediction_id);}catch(error){
    if([401,403,404].includes(error.status)){credits.attention(job.id,'Cannot retrieve the saved prediction. Check the API account and review this generation.');return;}
    await pause();continue;
   }
   if(stopped)return;
   if(['failed','canceled'].includes(result.status)){credits.settle(job.id,false,'Generation did not complete. Credits returned.');return;}
   if(result.status==='succeeded'){
    try{
     const out=result.output,url=typeof out==='string'?out:Array.isArray(out)?out[0]:out?.audio||out?.url;
     if(typeof url!=='string'||!url.startsWith('https://'))throw Error('Missing audio URL');
     const bytes=await download(url);if(!bytes.length)throw Error('Empty audio');
     const fd=fs.openSync(filename+'.tmp','w');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
     fs.renameSync(filename+'.tmp',filename);credits.settle(job.id,true);
    }catch(error){credits.attention(job.id,'Replicate finished, but the audio could not be saved. Check disk space and retry saving from Credit history.');}
    return;
   }
   await pause();
  }
 }
 function start(batch){
  if(stopped||!replicate||running.has(batch.id))return;
  running.add(batch.id);
  (async()=>{for(const job of credits.jobs(batch.id)){if(stopped)break;await jobRun(batch,job);}})()
   .catch(()=>{for(const job of credits.jobs(batch.id))if(!['ready','failed','queued'].includes(job.state))credits.attention(job.id,'Processing stopped unexpectedly. Review this generation.');})
   .finally(()=>{
    running.delete(batch.id);
    // A retry for A can arrive while B is still running. Pick it up once B finishes.
    if(!stopped && credits.jobs(batch.id).some(job=>['queued','running'].includes(job.state)))start(batch);
   });
 }
 return {start,stop:()=>{stopped=true;for(const timer of timers)clearTimeout(timer);},idle:()=>running.size===0};
}
module.exports={createRunner};
