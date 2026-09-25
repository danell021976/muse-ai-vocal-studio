const MuseAuth=(()=>{
 let user=null,mode='login',locked=false;
 const nativeFetch=window.fetch.bind(window);
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('muse-account'):null;
 function lock(){
  if(locked)return;locked=true;
  if(typeof libraryStorage!=='undefined')libraryStorage.lock();
  document.querySelectorAll('audio').forEach(player=>{player.pause();player.removeAttribute('src');player.load();});
  if(typeof stopVoiceRecording==='function')stopVoiceRecording();
  document.querySelector('.main-workspace').style.visibility='hidden';
  document.querySelector('.sidebar').style.visibility='hidden';
  location.reload();
 }
 if(channel)channel.onmessage=()=>lock();
 async function api(url,options={}){
  const response=await nativeFetch(url,{...options,cache:'no-store',headers:{'Content-Type':'application/json',
   ...(user?{'X-Muse-User':user.id}:{}),...options.headers}});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Account request failed.');
  return data;
 }
 async function privateFetch(url,options={}){
  if(locked || !user)throw Error('Sign in before using your library.');
  const response=await nativeFetch(url,{...options,cache:'no-store',headers:{...options.headers,'X-Muse-User':user.id}});
  if(response.status===401){lock();throw Error('Your session ended. Please sign in again.');}
  return response;
 }
 function setMode(value){
  mode=value;
  document.getElementById('authPassword').value='';
  document.getElementById('authError').textContent='';
  document.getElementById('setupCodeRow').hidden=mode!=='setup';
  document.getElementById('recoveryCodeRow').hidden=mode!=='recover';
  document.getElementById('authSubmit').textContent=({login:'Sign in',register:'Create account',setup:'Create my owner account',recover:'Reset password'})[mode];
  document.getElementById('authPassword').autocomplete=mode==='login'?'current-password':'new-password';
  document.getElementById('authHeading').textContent=mode==='setup'?'Welcome to your private studio':'Your MuseAI account';
  document.getElementById('authHelp').textContent=mode==='setup'?'Create your owner account to keep your existing library. Copy the setup code from the server terminal.':'Each account has its own library, songs and recordings.';
 }
 async function init(){
  try{
   const session=await api('/auth/session');
   if(session.user){
    user=session.user;
    document.querySelectorAll('.main-workspace, .sidebar, .player-bar').forEach(element=>element.removeAttribute('inert'));
    document.getElementById('accountName').textContent=user.username;
    document.getElementById('authScreen').hidden=true;return true;
   }
   document.getElementById('libraryLoading').hidden=true;
   document.getElementById('authScreen').hidden=false;
   document.getElementById('authModeRow').hidden=session.setupRequired;
   setMode(session.setupRequired?'setup':'login');
  }catch(error){
   document.getElementById('libraryLoading').hidden=true;
   document.getElementById('authScreen').hidden=false;
   document.getElementById('authError').textContent='Restart the updated server, then refresh. '+error.message;
  }
  return false;
 }
 async function submit(event){
  event.preventDefault();
  const button=document.getElementById('authSubmit');button.disabled=true;
  document.getElementById('authError').textContent='';
  try{
   const result=await api('/auth/'+mode,{method:'POST',body:JSON.stringify({
    username:document.getElementById('authUsername').value,password:document.getElementById('authPassword').value,
    setupCode:document.getElementById('authSetupCode').value.trim(),recoveryCode:document.getElementById('authRecoveryCode').value.trim()
   })});
   user=result.user;
   document.getElementById('authPassword').value='';
   document.getElementById('authSetupCode').value='';
   document.getElementById('authRecoveryCode').value='';
   channel?.postMessage('changed');
   if(result.recoveryCode){
    document.getElementById('authForm').hidden=true;
    document.getElementById('authModeRow').hidden=true;
    document.getElementById('recoveryResult').hidden=false;
    document.getElementById('newRecoveryCode').value=result.recoveryCode;
   }else location.reload();
  }catch(error){document.getElementById('authError').textContent=error.message;}
  finally{button.disabled=false;}
 }
 async function logout(){
  await libraryStorage.flush();
  if(!libraryStorage.canLeave())return alert('Your library has unsaved changes. Wait for it to save before signing out.');
  try{
   await api('/auth/logout',{method:'POST',body:'{}'});
   libraryStorage.clearPrivateCache();
   channel?.postMessage('changed');lock();
  }catch(error){alert(error.message);}
 }
 async function changePassword(event){
  event.preventDefault();
  const button=document.getElementById('passwordSubmit');button.disabled=true;
  try{
   await api('/auth/password',{method:'POST',body:JSON.stringify({username:user.username,
    currentPassword:document.getElementById('currentPassword').value,password:document.getElementById('newPassword').value})});
   document.getElementById('currentPassword').value='';document.getElementById('newPassword').value='';
   document.getElementById('passwordNotice').textContent='Password changed. Other sessions have been signed out.';
  }catch(error){document.getElementById('passwordNotice').textContent=error.message;}
  finally{button.disabled=false;}
 }
 return {init,submit,setMode,logout,changePassword,fetch:privateFetch,get user(){return user;}};
})();
