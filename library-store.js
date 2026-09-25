const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const MAX_BYTES = 24 * 1024 * 1024;
const keys = new Set(['muse_ai_library','muse_ai_custom_folders','muse_ai_folder_meta',
    'muse_ai_active_folder_view','muse_ai_tokens_avail','muse_ai_tokens_spent',
    'muse_ai_library_view','muse_ai_job_snapshot',
    ...['title','prompt','lyrics','exclusions','vocal','tier','voice_id'].map(k=>'muse_ai_draft_'+k)]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, statusCode=400) => Object.assign(new Error(message), {statusCode});
const allowedAsset = name => /^(?:mastered-song-\d+|song-[AB]-\d+)\.mp3$/.test(name) ||
    /^voices\/[a-f0-9-]{36}\.(?:wav|json)$/.test(name);

function createLibraryStore(root, {isBusy=()=>false}={}) {
    const directory = path.join(root, 'data');
    const currentFile = path.join(directory, 'library.json');
    const backups = path.join(root, 'backups', 'library');
    const assets = path.join(backups, 'assets');
    fs.mkdirSync(directory, {recursive:true});
    fs.mkdirSync(assets, {recursive:true});
    let recoveredFrom = null;

    function atomicWrite(filename, bytes) {
        const temp = filename + '.' + randomUUID() + '.tmp';
        let descriptor;
        try {
            descriptor = fs.openSync(temp, 'wx');
            fs.writeFileSync(descriptor, bytes);
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor); descriptor = undefined;
            fs.renameSync(temp, filename);
        } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
    }
    function validateState(state) {
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw fail('Invalid library snapshot.');
        for (const [key,value] of Object.entries(state)) {
            if (!keys.has(key) || typeof value !== 'string') throw fail('Invalid library field: ' + key);
            if (['muse_ai_custom_folders','muse_ai_folder_meta','muse_ai_job_snapshot','muse_ai_library_view'].includes(key)) {
                let parsed;try{parsed=JSON.parse(value);}catch{throw fail('Invalid saved data in '+key+'. The original was preserved.');}
                if (['muse_ai_custom_folders','muse_ai_folder_meta'].includes(key) && !Array.isArray(parsed))throw fail('Invalid folder data.');
            }
        }
        if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) throw fail('Library is too large to save.',413);
        return state;
    }
    function decode(text) {
        const envelope = JSON.parse(text);
        const data = envelope.data;
        if (!data || envelope.checksum !== digest(JSON.stringify(data)) || data.version !== 1 ||
            typeof data.revision !== 'string' || !Array.isArray(data.assets)) throw fail('Damaged library snapshot.',503);
        validateState(data.state);
        for (const item of data.assets) {
            if (!allowedAsset(item.name) || !/^[a-f0-9]{64}$/.test(item.hash)) throw fail('Invalid backup asset.',503);
        }
        return data;
    }
    function backupNames() {
        return fs.readdirSync(backups).filter(name=>/^\d{17}-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse();
    }
    function readCurrent() {
        if (fs.existsSync(currentFile)) {
            try { return decode(fs.readFileSync(currentFile,'utf8')); } catch {}
        } else if (!backupNames().length) return null;
        for (const name of backupNames()) {
            try {
                const bytes = fs.readFileSync(path.join(backups,name),'utf8');
                const data = decode(bytes);
                restoreAssets(data.assets);
                if (fs.existsSync(currentFile)) fs.copyFileSync(currentFile, currentFile+'.damaged-'+randomUUID());
                atomicWrite(currentFile, bytes);
                recoveredFrom = name;
                return data;
            } catch {}
        }
        throw fail('The library could not be read or recovered. Existing files have been kept. Restore your project backup before continuing.',503);
    }
    function captureAssets() {
        const names = fs.readdirSync(root).filter(allowedAsset);
        const voices = path.join(root,'voices');
        if (fs.existsSync(voices)) names.push(...fs.readdirSync(voices).map(name=>'voices/'+name).filter(allowedAsset));
        return names.map(name=>{
            const bytes=fs.readFileSync(path.join(root,name));
            const hash=digest(bytes), target=path.join(assets,hash);
            // Repair a damaged backup copy from the intact original.
            if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== hash) atomicWrite(target,bytes);
            return {name,hash,size:bytes.length};
        });
    }
    function restoreAssets(manifest) {
        // Verify every copy before changing any originals.
        const verified=manifest.map(item=>{
            const bytes=fs.readFileSync(path.join(assets,item.hash));
            if(digest(bytes)!==item.hash)throw fail('A backup audio file is damaged. Nothing was restored.',503);
            return {item,bytes};
        });
        for(const {item,bytes} of verified) {
            const target=path.join(root,item.name);
            if(fs.existsSync(target) && digest(fs.readFileSync(target))===item.hash)continue;
            fs.mkdirSync(path.dirname(target),{recursive:true});
            if(fs.existsSync(target))fs.copyFileSync(target,target+'.before-restore-'+randomUUID());
            atomicWrite(target,bytes);
        }
    }
    function save(state,baseRevision,writeId, reason='automatic') {
        validateState(state);
        const previous=readCurrent();
        if(previous?.writeId===writeId && writeId) return previous;
        if((previous?.revision || null)!==baseRevision)throw fail('This library changed in another tab. Your unsaved changes have been kept in this browser.',409);
        const data={version:1,revision:randomUUID(),writeId,reason,savedAt:new Date().toISOString(),state,assets:captureAssets()};
        const text=JSON.stringify({data,checksum:digest(JSON.stringify(data))});
        const name=data.savedAt.replace(/\D/g,'')+'-'+data.revision+'.json';
        // A verified backup is written before replacing the current library.
        atomicWrite(path.join(backups,name),text);
        atomicWrite(currentFile,text);
        // Keep 100 library versions. Shared audio copies are retained for recovery.
        for(const old of backupNames().slice(100)){
            try{fs.unlinkSync(path.join(backups,old));}catch{}
        }
        return data;
    }
    const publicData = data => ({revision:data?.revision || null,state:data?.state || null,
        savedAt:data?.savedAt || null,writeId:data?.writeId || null,recoveredFrom});
    async function handle(req,res) {
        if(!['/library','/library/backups','/library/restore'].includes(req.url))return false;
        const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
        try {
            if(!['localhost:3000','127.0.0.1:3000'].includes(req.headers.host))throw fail('Open the local MuseAI page.',403);
            if(req.method==='GET') {
                if(req.url==='/library')json(200,publicData(readCurrent()));
                else if(req.url==='/library/backups'){
                    readCurrent();
                    const list=[];
                    for(const name of backupNames()){
                        try{const data=decode(fs.readFileSync(path.join(backups,name),'utf8'));list.push({id:name,savedAt:data.savedAt,reason:data.reason,files:data.assets.length});}catch{}
                        if(list.length>=100)break;
                    }
                    json(200,list);
                } else throw fail('Method not allowed.',405);
            } else {
                if(req.headers.origin!=='http://'+req.headers.host || req.headers['x-muse-library']!=='1')throw fail('Library writes must come from this app.',403);
                if(!((req.url==='/library' && req.method==='PUT') || (req.url==='/library/restore' && req.method==='POST')))throw fail('Method not allowed.',405);
                let size=0;const chunks=[];
                for await(const chunk of req){size+=chunk.length;if(size>MAX_BYTES+65536)throw fail('Library is too large.',413);chunks.push(chunk);}
                const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if(typeof body.writeId!=='string' || !/^[a-f0-9-]{36}$/.test(body.writeId))throw fail('Invalid save identifier.');
                if(req.url==='/library')json(200,publicData(save(body.state,body.baseRevision,body.writeId)));
                else {
                    if(isBusy())throw fail('Wait for song generation to finish before restoring a backup.',409);
                    if(!backupNames().includes(body.id))throw fail('Backup not found.',404);
                    const current=readCurrent();
                    if(current?.writeId===body.writeId){json(200,publicData(current));return true;}
                    if((current?.revision||null)!==body.baseRevision)throw fail('Library changed. Reload before restoring.',409);
                    const data=decode(fs.readFileSync(path.join(backups,body.id),'utf8'));
                    // Preserve the latest library and media before restoring an older snapshot.
                    const before=save(current?.state||{},body.baseRevision,randomUUID(),'before restore');
                    restoreAssets(data.assets);
                    json(200,publicData(save(data.state,before.revision,body.writeId,'restored backup')));
                }
            }
        } catch(error) {json(error.statusCode || (error instanceof SyntaxError ? 400 : 500),{error:error.statusCode?error.message:'Could not save or read the library. Files were preserved. Check free disk space and folder access.'});}
        return true;
    }
    return {handle,readCurrent,save,backupNames,decode,restoreAssets};
}
module.exports={createLibraryStore};
