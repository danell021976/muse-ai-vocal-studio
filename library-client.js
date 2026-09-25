// The server is authoritative; browser storage is only a migration source and
// a recovery copy for edits made while disconnected.
const libraryStorage = (() => {
    const keys = ['muse_ai_library','muse_ai_custom_folders','muse_ai_folder_meta',
        'muse_ai_active_folder_view','muse_ai_tokens_avail','muse_ai_tokens_spent',
        'muse_ai_library_view','muse_ai_job_snapshot',
        ...['title','prompt','lyrics','exclusions','vocal','tier','voice_id'].map(k=>'muse_ai_draft_'+k)];
    let state={}, revision=null, ready=false, dirty=false, saving=false, blocked=false;
    let timer, inFlight=null, lastSaved=null;
    const clientId=crypto.randomUUID();
    let pendingKey, pendingPrefix;
    let inheritedPending=[];
    const status=message=>document.getElementById('librarySaveStatus').textContent=message;
    function readLocal(key){try{return localStorage.getItem(key);}catch{return null;}}
    function pendingCopies(){
        const copies=[];
        try{
            for(let i=0;i<localStorage.length;i++){
                const key=localStorage.key(i);
                if(!key.startsWith(pendingPrefix))continue;
                try{const value=JSON.parse(localStorage.getItem(key));if(value?.state && value.writeId)copies.push({key,...value});}catch{}
            }
        }catch{}
        return copies.sort((a,b)=>(b.at||0)-(a.at||0));
    }
    function cachePending(body){
        try {localStorage.setItem(pendingKey,JSON.stringify({...body,at:Date.now()}));return true;}
        catch {return false;}
    }
    function clearOwnPending(){
        try{localStorage.removeItem(pendingKey);for(const key of inheritedPending)localStorage.removeItem(key);}catch{}
        inheritedPending=[];
    }
    function notice(message, conflict=false){
        status(message);
        document.getElementById('reloadSavedLibrary').hidden=!conflict;
        document.getElementById('downloadUnsavedLibrary').hidden=!conflict;
        if(conflict){
            document.getElementById('libraryLoadingText').textContent=message;
            document.getElementById('libraryLoading').hidden=false;
        }
    }
    async function request(url,options={}){
        const response=await MuseAuth.fetch(url,{...options,cache:'no-store',signal:AbortSignal.timeout(30000),
            headers:{'Content-Type':'application/json','X-Muse-Library':'1',...options.headers}});
        const data=await response.json();
        if(!response.ok)throw Object.assign(new Error(data.error || 'Library request failed.'),{status:response.status});
        return data;
    }
    function showLoadingError(error){
        document.getElementById('libraryLoadingText').textContent='Could not load your library. '+error.message+' Restart the updated server and try again.';
        document.getElementById('retryLibraryLoad').hidden=false;
    }
    async function init(){
        try{
            pendingPrefix='muse_ai_pending_library_'+MuseAuth.user.id+'_';
            pendingKey=pendingPrefix+clientId;
            if(MuseAuth.user.owner){
                // Only the verified owner may claim pre-account recovery copies.
                try{
                    const oldKeys=[];
                    for(let i=0;i<localStorage.length;i++){
                        const key=localStorage.key(i);
                        if(/^muse_ai_pending_library_[a-f0-9-]{36}$/.test(key))oldKeys.push(key);
                    }
                    for(const key of oldKeys){
                        localStorage.setItem(pendingPrefix+key.slice('muse_ai_pending_library_'.length),localStorage.getItem(key));
                        localStorage.removeItem(key);
                    }
                }catch{}
            }
            const remote=await request('/library');
            revision=remote.revision;lastSaved=remote.savedAt;
            const copies=pendingCopies();
            const remaining=[];
            for(const copy of copies){
                if(copy.writeId===remote.writeId){
                    if(JSON.stringify(copy.state)!==JSON.stringify(remote.state))remaining.push({...copy,baseRevision:revision});
                    else try{localStorage.removeItem(copy.key);}catch{}
                }else remaining.push(copy);
            }
            if(remote.state===null){
                if(MuseAuth.user.owner)for(const key of keys){const value=readLocal(key);if(value!==null)state[key]=value;}
                if(remaining.length===1 && remaining[0].baseRevision===null){
                    state=remaining[0].state;inheritedPending=[remaining[0].key];
                }
                const body={state,baseRevision:null,writeId:crypto.randomUUID()};
                cachePending(body);
                const migrated=await request('/library',{method:'PUT',body:JSON.stringify(body)});
                revision=migrated.revision;lastSaved=migrated.savedAt;
                clearOwnPending();
            }else{
                state=remote.state;
                if(remaining.length===1 && remaining[0].baseRevision===revision){
                    state=remaining[0].state;inheritedPending=[remaining[0].key];dirty=true;
                }else if(remaining.length){
                    blocked=true;
                    notice('An unsaved browser copy differs from the saved library. Download it before choosing Use saved library.',true);
                }
            }
            if(remote.recoveredFrom && !blocked)notice('Library recovered automatically from a verified backup.');
            // Scope legacy audio URLs to the account before any card can play.
            for(const key of ['muse_ai_library','muse_ai_job_snapshot']){
                if(state[key])state[key]=state[key].replace(/(?<![a-zA-Z0-9_/-])\/(song-[AB]-\d+\.mp3|mastered-song-\d+\.mp3)/g,
                    '/media/'+MuseAuth.user.id+'/$1');
            }
            // The first owner import is now safely on disk; remove unscoped browser data.
            if(MuseAuth.user.owner)for(const key of keys){try{localStorage.removeItem(key);}catch{}}
            return true;
        }catch(error){showLoadingError(error);return false;}
    }
    function queue(){
        dirty=true;
        const cached=cachePending({state,baseRevision:revision,writeId:inFlight?.writeId || crypto.randomUUID()});
        status(cached ? 'Saving library…' : 'Saving library… Browser recovery storage is unavailable; keep this page open.');
        clearTimeout(timer);
        timer=setTimeout(flush,800);
    }
    async function flush(){
        clearTimeout(timer);
        if(!ready || blocked || saving || !dirty)return;
        saving=true;
        // Retry an uncertain request with the same identifier before newer edits.
        if(!inFlight)inFlight={state:JSON.parse(JSON.stringify(state)),baseRevision:revision,writeId:crypto.randomUUID()};
        cachePending({...inFlight,state});
        try{
            const result=await request('/library',{method:'PUT',body:JSON.stringify(inFlight)});
            revision=result.revision;lastSaved=result.savedAt;
            dirty=JSON.stringify(state)!==JSON.stringify(inFlight.state);
            inFlight=null;
            if(dirty)cachePending({state,baseRevision:revision,writeId:crypto.randomUUID()});
            else clearOwnPending();
            status(dirty?'Saving newer changes…':'Saved on this computer · '+new Date(lastSaved).toLocaleTimeString());
        }catch(error){
            if(error.status===409){blocked=true;notice(error.message+' Download your unsaved copy, then use the saved library.',true);}
            else status('Not saved to disk yet. Keep this page open. Retrying… '+error.message);
        }finally{
            saving=false;
            if(dirty && !blocked)timer=setTimeout(flush,inFlight?5000:100);
        }
    }
    function finish(){
        ready=true;
        if(blocked)return;
        document.getElementById('libraryLoading').hidden=true;
        queue();
    }
    function downloadPending(){
        const payload={exportedAt:new Date().toISOString(),currentEdits:state,recoveryCopies:pendingCopies()};
        const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
        const link=document.createElement('a');link.href=url;link.download='museai-unsaved-library.json';link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    function useSaved(){
        if(!confirm('Load the saved library from disk? Unsaved browser edits will be discarded. Download your unsaved copy first if you want to keep it.'))return;
        try{for(const copy of pendingCopies())localStorage.removeItem(copy.key);}catch{}
        dirty=false;blocked=true;location.reload();
    }
    async function openBackups(){
        if(dirty || saving || blocked){await flush();if(dirty || saving || blocked)return alert('Wait until the library is saved before opening backups.');}
        try{
            const list=await request('/library/backups');
            const select=document.getElementById('libraryBackupChoice');select.replaceChildren();
            for(const item of list)select.appendChild(new Option(new Date(item.savedAt).toLocaleString()+' · '+item.reason+' · '+item.files+' files',item.id));
            document.getElementById('restoreLibraryBackup').disabled=!list.length || generationBusy;
            document.getElementById('libraryBackupNotice').textContent=generationBusy?'Wait for song creation to finish before restoring.':'Restoring replaces the library with this snapshot. A backup of the current library is kept first.';
            document.getElementById('libraryBackupDialog').showModal();
        }catch(error){alert(error.message);}
    }
    async function restoreBackup(){
        if(generationBusy || dirty || saving || blocked)return alert('Finish song creation and wait for the library to save first.');
        const id=document.getElementById('libraryBackupChoice').value;
        if(!id || !confirm('Restore this backup? Your current library will be backed up first.'))return;
        blocked=true;
        document.getElementById('libraryBackupDialog').close();
        document.getElementById('libraryLoadingText').textContent='Restoring your library and audio files…';
        document.getElementById('libraryLoading').hidden=false;
        try{
            await request('/library/restore',{method:'POST',body:JSON.stringify({id,baseRevision:revision,writeId:crypto.randomUUID()})});
            clearOwnPending();dirty=false;location.reload();
        }catch(error){showLoadingError(error);}
    }
    window.addEventListener('beforeunload',event=>{if(dirty && !blocked){event.preventDefault();event.returnValue='';}});
    window.addEventListener('online',flush);
    return {init,finish,flush,openBackups,restoreBackup,downloadPending,useSaved,
        canLeave:()=>!dirty && !saving && !blocked,
        clearPrivateCache:()=>{clearOwnPending();for(const copy of pendingCopies()){try{localStorage.removeItem(copy.key);}catch{}}},
        lock:()=>{blocked=true;clearTimeout(timer);},
        getItem:key=>state[key] ?? null,
        setItem(key,value){
            if(!keys.includes(key))throw new Error('Unknown library field.');
            const text=String(value);
            if(state[key]===text)return;
            state[key]=text;
            if(ready && !blocked)queue();
        }};
})();
