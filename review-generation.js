// Offline owner recovery tool. Stop app.js before running this file.
const {createCredits}=require('./credits-store');
const credits=createCredits(__dirname);
const [command,id]=process.argv.slice(2);
try{
 const pending=credits.pending();const jobs=pending.flatMap(batch=>credits.jobs(batch.id)).filter(job=>job.state==='attention');
 if(command==='release'&&id){
  const job=jobs.find(job=>job.id===id);if(!job)throw Error('No generation awaiting review with that ID.');
  credits.settle(id,false,'Owner reviewed the uncertain generation and released its app credits.');
  console.log('Released app credits. No Replicate request or refund was made.');
 }else{
  console.log('Stop the MuseAI server before using this tool. Review these predictions in your Replicate account before releasing credits:');
  for(const job of jobs)console.log(JSON.stringify({job:job.id,prediction:job.prediction_id,account:job.user_id,reason:job.error}));
  console.log('After review: node review-generation.js release track-A-...');
 }
}finally{credits.close();}
