const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {createAccounts}=require('./accounts');
const {createUserStorage}=require('./user-storage');
const {createCredits}=require('./credits-store');
const {createRunner}=require('./generation-runner');

function validateMusicInput(input){
 const lyrics=typeof input?.lyrics==='string'?input.lyrics.trim():'';
 const prompt=typeof input?.prompt==='string'?input.prompt.trim():'';
 if([...lyrics].length<10 || [...lyrics].length>3500)throw Object.assign(new Error('Lyrics must be 10–3500 characters.'),{statusCode:400});
 if([...prompt].length<10 || [...prompt].length>2000)throw Object.assign(new Error('The complete style prompt must be 10–2000 characters.'),{statusCode:400});
 return {lyrics,prompt};
}
function createApp(root,{replicate=null,setupCode,download=async url=>{
 const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Audio download failed.');
 const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length)throw Error('Empty audio download.');return bytes;
},variantDelay=4000,pollDelay=3000}={}){
 const credits=createCredits(root);
 const stores=createUserStorage(root,{isBusy:uid=>credits.active(uid)});
 const accounts=createAccounts(root,{setupCode,onOwnerCreated:stores.migrateOwner});
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 const ensure=user=>credits.ensure(user,()=>stores.get(user).library.readCurrent()?.state);
 for(const user of accounts.listUsers())ensure(user);
 credits.recoverSubmitting();
 const runner=createRunner({credits,stores,replicate,download,pollDelay});
 for(const batch of credits.pending())runner.start(batch);
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  try{
   accounts.guard(req);
   if(await accounts.handle(req,res))return;
   const publicFiles={'/':'index.html','/library-client.js':'library-client.js','/auth-client.js':'auth-client.js'};
   if(req.method==='GET' && publicFiles[req.url]){
    res.setHeader('Content-Type',req.url==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');
    return res.end(fs.readFileSync(path.join(root,publicFiles[req.url])));
   }
   // Audio elements cannot attach custom headers; owner IDs in the URL bind
   // them to the signed-in account instead.
   const media=req.url.match(/^\/media\/([a-f0-9-]{36})\/((?:song-[AB]-\d+|mastered-song-\d+)\.mp3)$/);
   if(req.method==='GET' && media){
    const user=accounts.current(req);
    if(!user)return json(res,401,{error:'Sign in to listen.'});
    if(user.id!==media[1])return json(res,404,{error:'Song not found.'});
    const filename=path.join(stores.get(user).directory,media[2]);
    if(!fs.existsSync(filename))return json(res,404,{error:'Song not found.'});
    res.setHeader('Content-Type','audio/mpeg');return res.end(fs.readFileSync(filename));
   }
   const voice=req.url.match(/^\/private-voices\/([a-f0-9-]{36})\/([a-f0-9-]{36})\.wav$/);
   if(req.method==='GET' && voice){
    const user=accounts.current(req);
    if(!user)return json(res,401,{error:'Sign in to listen.'});
    if(user.id!==voice[1])return json(res,404,{error:'Recording not found.'});
    req.url='/voices/'+voice[2]+'.wav';return await stores.get(user).voices.handle(req,res);
   }
   if(req.method==='GET' && req.url.startsWith('/download/')){
    const user=accounts.current(req);if(!user)return json(res,401,{error:'Sign in to download.'});
    const filename=credits.downloadFile(user.id,req.url.slice('/download/'.length));
    if(!filename)return json(res,404,{error:'Download not found.'});
    const full=path.join(stores.get(user).directory,filename);
    if(!fs.existsSync(full))return json(res,404,{error:'Audio file is missing.'});
    res.setHeader('Content-Type','audio/mpeg');res.setHeader('Content-Disposition','attachment; filename="'+filename+'"');
    return res.end(fs.readFileSync(full));
   }
   const user=accounts.context(req),context=stores.get(user);
   ensure(user);
   if(req.method==='POST' && req.url==='/purchases/test'){
    const data=await accounts.body(req);return json(res,200,credits.purchase(user.id,data.requestId,data.product));
   }
   if(req.method==='POST' && req.url==='/downloads'){
    const data=await accounts.body(req),filename=typeof data.filename==='string'?data.filename:'';
    if(!stores.audioName.test(filename)||!fs.existsSync(path.join(context.directory,filename)))return json(res,404,{error:'Song file not found.'});
    credits.authorizeDownload(user.id,data.requestId,filename);
    return json(res,200,{url:'/download/'+data.requestId});
   }
   if(req.method==='GET' && req.url==='/credits')return json(res,200,{...credits.wallet(user.id),history:credits.history(user.id),attention:credits.attentionJobs(user.id)});
   if(req.method==='GET' && req.url==='/generation/latest')return json(res,200,{batch:credits.latest(user.id)});
   if(req.method==='POST' && req.url==='/credits/retry-save'){
    if(!replicate)return json(res,503,{error:'The server owner must configure the music connection before recovery can continue.'});
    const data=await accounts.body(req),job=credits.getJob(user.id,data.jobId);
    if(!job)return json(res,404,{error:'Song not found.'});
    if(job.state==='attention'&&!job.prediction_id)return json(res,409,{error:'The server owner must review this submission first. Creating it again could duplicate the request.'});
    credits.retrySave(user.id,data.jobId);
    for(const batch of credits.pending())if(batch.user_id===user.id)runner.start(batch);
    return json(res,200,{ok:true});
   }
   if(await context.library.handle(req,res))return;
   if(req.url==='/voices' && await context.voices.handle(req,res))return;
   if(req.method==='GET' && req.url.startsWith('/status-check?')){
    const id=new URL(req.url,'http://localhost:3000').searchParams.get('id');
    const job=credits.getJob(user.id,id);
    return json(res,200,job?{status:['ready','failed','attention'].includes(job.state)?job.state:'cooking',canRecover:job.state==='attention'&&Boolean(job.prediction_id),error:job.error,url:job.url}:context.jobs[id]||{status:'unknown'});
   }
   if(req.method==='POST' && req.url==='/generate'){
    if(!replicate)return json(res,503,{error:'Set REPLICATE_API_TOKEN and restart the server.'});
    const data=await accounts.body(req,65536),input=validateMusicInput(data);
    if(!['male','female','custom'].includes(data.vocalProfile))return json(res,400,{error:'Choose a vocal profile.'});
    if(data.vocalProfile==='custom' || data.voiceId)return json(res,400,{error:'Music 2.6 cannot use saved voice recordings. Nothing was submitted.'});
    if(Object.values(context.jobs).some(job=>job.status==='cooking'))return json(res,409,{error:'Your songs are still being created. Wait before starting another pair.'});
    const title=typeof data.settings?.title==='string'?data.settings.title.trim().slice(0,200):'';
    if(!title)return json(res,400,{error:'Enter a song title.'});
    const settings={version:1,title,style:String(data.settings.style||'').slice(0,2000),lyrics:input.lyrics,exclusions:String(data.settings.exclusions||'').slice(0,2000),vocal:data.vocalProfile,tier:String(data.settings.tier||'simple').slice(0,20),submittedPrompt:input.prompt};
    const result=credits.reserve(user.id,data.requestId,{input,settings,folder:String(data.folder||'main').slice(0,200)});
    json(res,200,credits.batchResponse(result.batch));runner.start(result.batch);
    return;
   }
   json(res,404,{error:'Not found.'});
  }catch(error){json(res,error.statusCode||500,{error:error.statusCode?error.message:'The request could not be completed. Your files have been kept.'});}
 });
 return {server,accounts,credits,runner};
}
if(require.main===module){
 const {createProvider}=require('./replicate-provider');
 const token=process.env.REPLICATE_API_TOKEN;
 const app=createApp(__dirname,{replicate:token?createProvider(token):null});
 app.server.listen(3000,'127.0.0.1',()=>{
  console.log('MuseAI running at http://localhost:3000');
  const setup=app.accounts.setupMessage();if(setup)console.log(setup);
 });
}
module.exports={createApp,validateMusicInput};
