const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const COST=5,TRIAL=500;
const PLANS={free:{credits:500,downloads:10},pro:{credits:5000,downloads:25},premium:{credits:10000,downloads:60}};
const bad=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
function createCredits(root){
 fs.mkdirSync(path.join(root,'accounts'),{recursive:true});
 const db=new DatabaseSync(path.join(root,'accounts','credits.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
 db.exec(`
 CREATE TABLE IF NOT EXISTS wallets(user_id TEXT PRIMARY KEY,available INTEGER NOT NULL CHECK(available>=0),reserved INTEGER NOT NULL CHECK(reserved>=0),spent INTEGER NOT NULL CHECK(spent>=0));
 CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES wallets(user_id),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(user_id,request_key));
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id),user_id TEXT NOT NULL,label TEXT NOT NULL,url TEXT NOT NULL,state TEXT NOT NULL,prediction_id TEXT,error TEXT,cost INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,job_id TEXT,kind TEXT NOT NULL,amount INTEGER NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS subscriptions(user_id TEXT PRIMARY KEY,plan TEXT NOT NULL,next_plan TEXT NOT NULL,period TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,extra INTEGER NOT NULL DEFAULT 0,credit_tier INTEGER NOT NULL DEFAULT 500);
 CREATE TABLE IF NOT EXISTS purchases(user_id TEXT NOT NULL,request_id TEXT NOT NULL,product TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(user_id,request_id));
 CREATE TABLE IF NOT EXISTS downloads(user_id TEXT NOT NULL,request_id TEXT NOT NULL,filename TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(user_id,request_id));
 `);
 function tx(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
 function event(uid,id,kind,amount,title){db.prepare('INSERT INTO ledger(user_id,job_id,kind,amount,title,created) VALUES(?,?,?,?,?,?)').run(uid,id,kind,amount,title,Date.now());}
 function ensure(user,readLegacy){
  if(db.prepare('SELECT user_id FROM wallets WHERE user_id=?').get(user.id))return;
  const state=readLegacy?.()||{};
  const valid=value=>value!==undefined && value!==null && value!=='' && Number.isSafeInteger(Number(value)) && Number(value)>=0 && Number(value)<=TRIAL;
  const available=valid(state.muse_ai_tokens_avail)?Number(state.muse_ai_tokens_avail):TRIAL;
  const spent=valid(state.muse_ai_tokens_spent)?Number(state.muse_ai_tokens_spent):0;
  tx(()=>{db.prepare('INSERT INTO wallets VALUES(?,?,0,?)').run(user.id,available,spent);event(user.id,null,'allowance',available,valid(state.muse_ai_tokens_avail)?'Imported remaining allowance':'Starting allowance');});
 }
 function wallet(uid){
  renew(uid);
  const row=db.prepare('SELECT available,reserved,spent FROM wallets WHERE user_id=?').get(uid);
  if(!row)throw bad('Credit account unavailable.',503);
  return {...row,costPerSong:COST,...subscription(uid)};
 }
 const period=()=>new Date().toISOString().slice(0,7);
 function renew(uid){
  db.prepare("INSERT OR IGNORE INTO subscriptions(user_id,plan,next_plan,period) VALUES(?,'free','free',?)").run(uid,period());
  const sub=db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(uid);
  if(sub.period===period())return;
  tx(()=>{
   const allowance=PLANS[sub.next_plan].credits;
   // Reserved jobs keep their reservation across a calendar month boundary.
   db.prepare('UPDATE wallets SET available=? WHERE user_id=?').run(allowance,uid);
   db.prepare('UPDATE subscriptions SET plan=next_plan,period=?,used=0,credit_tier=? WHERE user_id=?').run(period(),allowance,uid);
   event(uid,null,'allowance',allowance,'Monthly '+sub.next_plan+' allowance');
  });
 }
 function subscription(uid){
  const s=db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(uid);
  return {plan:s.plan,nextPlan:s.next_plan,period:s.period,monthlyDownloads:PLANS[s.plan].downloads,downloadsUsed:s.used,extraDownloads:s.extra,downloadsAvailable:Math.max(0,PLANS[s.plan].downloads-s.used)+s.extra,testPurchases:true};
 }
 function purchase(uid,key,product){
  renew(uid);
  if(typeof key!=='string'||!/^[a-f0-9-]{36}$/.test(key))throw bad('Missing purchase identifier.');
  if(!Object.hasOwn(PLANS,product)&&!['downloads-1','downloads-10','downloads-20'].includes(product))throw bad('Unknown test purchase.');
  tx(()=>{
   const old=db.prepare('SELECT product FROM purchases WHERE user_id=? AND request_id=?').get(uid,key);
   if(old){if(old.product!==product)throw bad('Purchase identifier already used.',409);return;}
   const sub=db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(uid);
   if(PLANS[product]){
    const target=PLANS[product];
    if(target.credits>=PLANS[sub.plan].credits){
     const extra=Math.max(0,target.credits-sub.credit_tier);
     db.prepare('UPDATE wallets SET available=available+? WHERE user_id=?').run(extra,uid);
     db.prepare('UPDATE subscriptions SET plan=?,next_plan=?,credit_tier=MAX(credit_tier,?) WHERE user_id=?').run(product,product,target.credits,uid);
     event(uid,null,'test plan',extra,product+' plan activated');
    }else{db.prepare('UPDATE subscriptions SET next_plan=? WHERE user_id=?').run(product,uid);event(uid,null,'test plan',0,product+' plan scheduled for next month');}
   }else{
    const amount=Number(product.split('-')[1]);db.prepare('UPDATE subscriptions SET extra=extra+? WHERE user_id=?').run(amount,uid);
    event(uid,null,'test purchase',0,amount+' extra downloads');
   }
   db.prepare('INSERT INTO purchases VALUES(?,?,?,?)').run(uid,key,product,Date.now());
  });
  return wallet(uid);
 }
 function authorizeDownload(uid,key,filename){
  renew(uid);
  if(typeof key!=='string'||!/^[a-f0-9-]{36}$/.test(key))throw bad('Missing download identifier.');
  tx(()=>{
   const old=db.prepare('SELECT filename FROM downloads WHERE user_id=? AND request_id=?').get(uid,key);
   if(old){if(old.filename!==filename)throw bad('Download identifier already used.',409);return;}
   const s=db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(uid);
   if(s.used<PLANS[s.plan].downloads)db.prepare('UPDATE subscriptions SET used=used+1 WHERE user_id=?').run(uid);
   else if(s.extra>0)db.prepare('UPDATE subscriptions SET extra=extra-1 WHERE user_id=?').run(uid);
   else throw bad('Your monthly downloads are used up. Add a test download bundle in Plans & downloads.',402);
   db.prepare('INSERT INTO downloads VALUES(?,?,?,?)').run(uid,key,filename,Date.now());
   event(uid,null,'download',0,filename);
  });
 }
 function downloadFile(uid,key){return db.prepare('SELECT filename FROM downloads WHERE user_id=? AND request_id=?').get(uid,key)?.filename;}
 function getJob(uid,id){return db.prepare('SELECT * FROM jobs WHERE user_id=? AND id=?').get(uid,id);}
 function jobs(batchId){return db.prepare('SELECT * FROM jobs WHERE batch_id=? ORDER BY label').all(batchId);}
 function active(uid){return Boolean(db.prepare("SELECT id FROM jobs WHERE user_id=? AND state NOT IN ('ready','failed') LIMIT 1").get(uid));}
 function reserve(uid,key,payload){
  renew(uid);
  if(typeof key!=='string' || !/^[a-f0-9-]{36}$/.test(key))throw bad('A request identifier is required. Refresh the app before creating songs.');
  const encoded=JSON.stringify(payload),hash=crypto.createHash('sha256').update(encoded).digest('hex');
  return tx(()=>{
   const old=db.prepare('SELECT * FROM batches WHERE user_id=? AND request_key=?').get(uid,key);
   if(old){if(old.request_hash!==hash)throw bad('This request identifier was already used for different song settings.',409);return {batch:old,reused:true};}
   if(active(uid))throw bad('Your previous songs are still processing or need review. Open Credit history for details.',409);
   const changed=db.prepare('UPDATE wallets SET available=available-?,reserved=reserved+? WHERE user_id=? AND available>=?').run(COST*2,COST*2,uid,COST*2);
   if(changed.changes!==1)throw bad('Not enough credits to create two songs.',402);
   const id=crypto.randomUUID(),stamp=Math.max(Date.now(),Number(db.prepare('SELECT MAX(created) AS last FROM batches').get().last||0)+1);
   db.prepare('INSERT INTO batches VALUES(?,?,?,?,?,?)').run(id,uid,key,hash,encoded,stamp);
   for(const label of ['A','B']){
    const jobId='track-'+label+'-'+stamp,url='/media/'+uid+'/song-'+label+'-'+stamp+'.mp3';
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(jobId,id,uid,label,url,'queued',null,null,COST);
    event(uid,jobId,'reserved',COST,payload.settings.title+' (Variant '+label+')');
   }
   return {batch:db.prepare('SELECT * FROM batches WHERE id=?').get(id),reused:false};
  });
 }
 function claim(id){return db.prepare("UPDATE jobs SET state='submitting',error=NULL WHERE id=? AND state='queued'").run(id).changes===1;}
 function prediction(id,pid){db.prepare("UPDATE jobs SET state='running',prediction_id=?,error=NULL WHERE id=? AND state='submitting'").run(pid,id);}
 function attention(id,message){db.prepare("UPDATE jobs SET state='attention',error=? WHERE id=? AND state NOT IN ('ready','failed')").run(message,id);}
 function settle(id,success,message=null){
  return tx(()=>{
   const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
   if(!job || ['ready','failed'].includes(job.state))return false;
   if(success && !job.prediction_id)throw Error('Cannot charge a job with no confirmed prediction.');
   if(success)db.prepare('UPDATE wallets SET reserved=reserved-?,spent=spent+? WHERE user_id=?').run(job.cost,job.cost,job.user_id);
   else db.prepare('UPDATE wallets SET reserved=reserved-?,available=available+? WHERE user_id=?').run(job.cost,job.cost,job.user_id);
   db.prepare('UPDATE jobs SET state=?,error=? WHERE id=?').run(success?'ready':'failed',message,id);
   const batch=db.prepare('SELECT payload FROM batches WHERE id=?').get(job.batch_id);
   event(job.user_id,id,success?'charged':'released',job.cost,JSON.parse(batch.payload).settings.title+' (Variant '+job.label+')');
   return true;
  });
 }
 function batchResponse(batch){
  const payload=JSON.parse(batch.payload),tracks=jobs(batch.id);
  return {requestId:batch.request_key,settings:payload.settings,folder:payload.folder,created:batch.created,
   tracks:tracks.map(job=>({jobId:job.id,cardId:'card-'+job.id,label:job.label,url:job.url,
    title:payload.settings.title+' (Variant '+job.label+')',state:job.state,error:job.error})),
   ...Object.fromEntries(tracks.flatMap(job=>[['trackId'+job.label,job.id],['fileUrl'+job.label,job.url]]))};
 }
 function latest(uid){const batch=db.prepare('SELECT * FROM batches WHERE user_id=? ORDER BY created DESC LIMIT 1').get(uid);return batch?batchResponse(batch):null;}
 function history(uid){return db.prepare('SELECT job_id AS jobId,kind,amount,title,created FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100').all(uid);}
 function recoverSubmitting(){db.prepare("UPDATE jobs SET state='attention',error='The server restarted during submission. Do not resubmit: Replicate may already be processing this song.' WHERE state='submitting'").run();}
 return {ensure,wallet,reserve,claim,prediction,attention,settle,getJob,jobs,active,latest,history,batchResponse,recoverSubmitting,purchase,authorizeDownload,downloadFile,
  retrySave:(uid,id)=>db.prepare("UPDATE jobs SET state='running',error=NULL WHERE user_id=? AND id=? AND state='attention' AND prediction_id IS NOT NULL").run(uid,id).changes===1,
  pending:()=>db.prepare("SELECT * FROM batches WHERE id IN (SELECT batch_id FROM jobs WHERE state NOT IN ('ready','failed')) ORDER BY created").all(),
  attentionJobs:uid=>db.prepare("SELECT id,error,prediction_id AS predictionId FROM jobs WHERE user_id=? AND state='attention'").all(uid),
  close:()=>db.close()};
}
module.exports={createCredits};
