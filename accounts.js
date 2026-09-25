const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {promisify}=require('node:util');
const {DatabaseSync}=require('node:sqlite');
const scrypt=promisify(crypto.scrypt);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const bad=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const publicUser=user=>({id:user.id,username:user.username,owner:Boolean(user.owner)});
const cookieName='muse_session';
async function passwordHash(password,salt=crypto.randomBytes(16).toString('hex')){
 const derived=await scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024});
 return salt+':'+derived.toString('hex');
}
async function passwordMatches(password,stored){
 const [salt,key]=stored.split(':');const actual=(await passwordHash(password,salt)).split(':')[1];
 return crypto.timingSafeEqual(Buffer.from(key,'hex'),Buffer.from(actual,'hex'));
}
function createAccounts(root,{setupCode=crypto.randomBytes(24).toString('hex'),onOwnerCreated=()=>{}}={}){
 const dir=path.join(root,'accounts');fs.mkdirSync(dir,{recursive:true});
 const db=new DatabaseSync(path.join(dir,'accounts.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
 db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, recovery TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);');
 const users=()=>db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
 function throttle(key,limit){
  const now=Date.now(),row=db.prepare('SELECT * FROM limits WHERE key=?').get(key);
  if(row && row.expires>now && row.count>=limit)throw bad('Too many attempts. Please wait 15 minutes.',429);
  db.prepare('INSERT INTO limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires').run(key,row && row.expires>now?row.count+1:1,row && row.expires>now?row.expires:now+15*60*1000);
  db.prepare('DELETE FROM limits WHERE expires < ?').run(now);
 }
 function token(req){return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';}
 function current(req){
  const value=token(req);if(!/^[a-f0-9]{64}$/.test(value))return null;
  return db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?').get(hash(value),Date.now())||null;
 }
 function session(user,res,req){
  const old=token(req);if(old)db.prepare('DELETE FROM sessions WHERE token=?').run(hash(old));
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  const value=crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(value),user.id,Date.now()+24*60*60*1000);
  res.setHeader('Set-Cookie',cookieName+'='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400');
 }
 function context(req){
  const user=current(req);if(!user)throw bad('Please sign in to continue.',401);
  if(req.headers['x-muse-user']!==user.id)throw bad('Your account changed in another tab. Refresh to continue.',401);
  return user;
 }
 function guard(req){
  if(!['localhost:3000','127.0.0.1:3000'].includes(req.headers.host))throw bad('Open MuseAI at http://localhost:3000.',403);
  if(!['GET','HEAD'].includes(req.method) && req.headers.origin!=='http://'+req.headers.host)throw bad('This action must come from the MuseAI page.',403);
 }
 async function body(req,maxBytes=16384){
  const chunks=[];let n=0;
  for await(const chunk of req){n+=chunk.length;if(n>maxBytes)throw bad('Request too large.',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw bad('Invalid request.');}
 }
 function credentials(input){
  const username=typeof input.username==='string'?input.username.trim().toLowerCase():'';
  if(!/^[a-z0-9_]{3,32}$/.test(username))throw bad('Use 3–32 letters, numbers or underscores for your username.');
  if(typeof input.password!=='string' || input.password.length<12 || input.password.length>128)throw bad('Use a password between 12 and 128 characters.');
  return {username,password:input.password};
 }
 let working=0;
 async function handle(req,res){
  if(!req.url.startsWith('/auth/'))return false;
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  let busy=false;
  try{
   guard(req);
   if(req.method==='GET' && req.url==='/auth/session'){
    const user=current(req);json(200,{user:user?publicUser(user):null,setupRequired:users()===0});return true;
   }
   if(req.method!=='POST')throw bad('Not found.',404);
   if(req.url==='/auth/logout'){
    context(req);db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token(req)));
    res.setHeader('Set-Cookie',cookieName+'=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');json(200,{ok:true});return true;
   }
   if(!['/auth/setup','/auth/register','/auth/login','/auth/recover','/auth/password'].includes(req.url))throw bad('Not found.',404);
   const input=await body(req);
   throttle('address:'+req.socket?.remoteAddress,40);
   throttle('name:'+String(input.username||'').trim().toLowerCase(),12);
   if(working>=2)throw bad('Another sign-in is processing. Please try again shortly.',429);
   working++;busy=true;
   if(req.url==='/auth/password'){
    const user=context(req);
    if(typeof input.currentPassword!=='string' || input.currentPassword.length>128 || !await passwordMatches(input.currentPassword,user.password))throw bad('Current password is incorrect.',401);
    const {password}=credentials({username:user.username,password:input.password});
    const encoded=await passwordHash(password);
    db.exec('BEGIN IMMEDIATE');
    try{
     const result=db.prepare('UPDATE users SET password=? WHERE id=? AND password=?').run(encoded,user.id,user.password);
     if(result.changes!==1)throw bad('Password changed in another session. Sign in again.',401);
     db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    session(user,res,req);json(200,{user:publicUser(user)});return true;
   }
   const {username,password}=credentials(input);
   if(req.url==='/auth/setup' || req.url==='/auth/register'){
    const owner=req.url==='/auth/setup';
    if(owner){
     if(users()!==0)throw bad('The owner account has already been created.',409);
     if(typeof input.setupCode!=='string' || hash(input.setupCode)!==hash(setupCode))throw bad('Enter the setup code shown in the server terminal.',403);
    }else if(users()===0)throw bad('Create the owner account first.',403);
    if(db.prepare('SELECT id FROM users WHERE username=?').get(username))throw bad('Choose a different username.',409);
    const encoded=await passwordHash(password);
    const user={id:crypto.randomUUID(),username,owner:owner?1:0};
    const recoveryCode=crypto.randomBytes(32).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try{
     if(owner && users()!==0)throw bad('The owner account has already been created.',409);
     if(owner)onOwnerCreated(user);
     else fs.mkdirSync(path.join(root,'users',user.id),{recursive:true});
     db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id,username,encoded,hash(recoveryCode),user.owner);
     db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    session(user,res,req);json(201,{user:publicUser(user),recoveryCode});return true;
   }
   const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
   if(req.url==='/auth/recover'){
    if(!user || typeof input.recoveryCode!=='string' || hash(input.recoveryCode.trim())!==user.recovery)throw bad('Username or recovery code is incorrect.',401);
    const encoded=await passwordHash(password),recoveryCode=crypto.randomBytes(32).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try{
     const result=db.prepare('UPDATE users SET password=?,recovery=? WHERE id=? AND recovery=?').run(encoded,hash(recoveryCode),user.id,user.recovery);
     if(result.changes!==1)throw bad('Recovery code has already been used.',401);
     db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    session(user,res,req);json(200,{user:publicUser(user),recoveryCode});return true;
   }
   // Hash even unknown users to avoid a fast username-existence signal.
   const expected=user?.password || '00000000000000000000000000000000:'+('00'.repeat(64));
   if(!await passwordMatches(password,expected) || !user)throw bad('Username or password is incorrect.',401);
   if(db.prepare('SELECT password FROM users WHERE id=?').get(user.id)?.password!==user.password)throw bad('Password changed. Please sign in again.',401);
   session(user,res,req);json(200,{user:publicUser(user)});
  }catch(error){json(error.statusCode||500,{error:error.statusCode?error.message:'Account operation failed. Please try again.'});}
  finally{if(busy)working--;}
  return true;
 }
 return {handle,current,context,guard,body,listUsers:()=>db.prepare('SELECT id,username,owner FROM users').all(),close:()=>db.close(),
  setupMessage:()=>users()===0?'Create your owner account at http://localhost:3000. Setup code: '+setupCode:null};
}
module.exports={createAccounts};
