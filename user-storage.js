const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createLibraryStore}=require('./library-store');
const {createVoiceStore}=require('./voice-store');
const audioName=/^(?:song-[AB]-\d+|mastered-song-\d+)\.mp3$/;
function createUserStorage(root,{isBusy=()=>false}={}){
 const contexts=new Map();
 function migrateOwner(user){
  const destination=path.join(root,'users',user.id);
  fs.mkdirSync(destination,{recursive:true});
  // Copy only app data. Original files and old backups remain untouched.
  for(const name of fs.readdirSync(root).filter(name=>audioName.test(name)))fs.copyFileSync(path.join(root,name),path.join(destination,name));
  for(const name of ['voices','backups/library']){
   const source=path.join(root,name);
   if(fs.existsSync(source)){fs.mkdirSync(path.dirname(path.join(destination,name)),{recursive:true});fs.cpSync(source,path.join(destination,name),{recursive:true,errorOnExist:true,force:false});}
  }
  for(const name of ['data/library.json','track-jobs.json']){
   const source=path.join(root,name);if(!fs.existsSync(source))continue;
   fs.mkdirSync(path.dirname(path.join(destination,name)),{recursive:true});fs.copyFileSync(source,path.join(destination,name));
  }
  // A damaged legacy library must recover before the owner account is committed.
  createLibraryStore(destination).readCurrent();
 }
 function get(user){
  if(contexts.has(user.id))return contexts.get(user.id);
  if(!/^[a-f0-9-]{36}$/.test(user.id))throw Error('Invalid account');
  const directory=path.join(root,'users',user.id);fs.mkdirSync(directory,{recursive:true});
  const registryPath=path.join(directory,'track-jobs.json');
  let jobs={};
  if(fs.existsSync(registryPath))jobs=JSON.parse(fs.readFileSync(registryPath,'utf8'));
  function saveJobs(){
   const temp=registryPath+'.'+crypto.randomUUID()+'.tmp';
   fs.writeFileSync(temp,JSON.stringify(jobs));fs.renameSync(temp,registryPath);
  }
  for(const job of Object.values(jobs))if(job.status==='cooking'){job.status='failed';job.error='Server restarted before generation finished. Check your files before retrying.';}
  saveJobs();
  const context={directory,jobs,saveJobs};
  context.library=createLibraryStore(directory,{isBusy:()=>isBusy(user.id)||Object.values(jobs).some(job=>job.status==='cooking')});
  context.voices=createVoiceStore(directory);
  contexts.set(user.id,context);return context;
 }
 return {get,migrateOwner,audioName};
}
module.exports={createUserStorage};
