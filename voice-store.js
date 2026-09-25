const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');


const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const bad = message => Object.assign(new Error(message), {statusCode:400});

function validateWav(buffer) {
    if (buffer.length < 44 || buffer.toString('ascii',0,4) !== 'RIFF' ||
        buffer.toString('ascii',8,12) !== 'WAVE' || buffer.toString('ascii',12,16) !== 'fmt ' ||
        buffer.readUInt32LE(16) !== 16 || buffer.readUInt16LE(20) !== 1 ||
        buffer.readUInt16LE(22) !== 1 || buffer.readUInt16LE(34) !== 16 ||
        buffer.toString('ascii',36,40) !== 'data') throw bad('Record a new voice sample using this app.');
    const rate = buffer.readUInt32LE(24);
    const bytes = buffer.readUInt32LE(40);
    if (rate < 8000 || rate > 48000 || bytes !== buffer.length-44 || bytes % 2 ||
        buffer.readUInt32LE(4) !== buffer.length-8 || buffer.readUInt16LE(32) !== 2 ||
        buffer.readUInt32LE(28) !== rate*2) throw bad('Invalid voice recording. Please record again.');
    const duration = bytes / (rate*2);
    if (duration < 16 || duration > 61) throw bad('Record between 16 and 60 seconds of voice.');
    return duration;
}

function createVoiceStore(root) {
const directory = path.join(root, 'voices');
function getVoiceFile(id) {
    if (!validId(id)) throw bad('Choose a saved voice recording first.');
    const filename = path.join(directory, id + '.wav');
    if (!fs.existsSync(filename)) throw bad('That saved voice is no longer available. Record or select another.');
    return filename;
}

async function handle(req,res) {
    if (!(req.url === '/voices' || req.url.startsWith('/voices/'))) return false;
    const json = (status,value) => {
        res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(value));
    };
    try {
        if (!['localhost:3000','127.0.0.1:3000'].includes(req.headers.host)) {
            json(403,{error:'Use the local MuseAI page.'}); return true;
        }
        if (req.url === '/voices' && req.method === 'GET') {
            const list = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name=>name.endsWith('.json')).flatMap(name=>{
                try {
                    const item=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
                    if (!validId(item.id) || !fs.existsSync(path.join(directory,item.id+'.wav'))) return [];
                    return [item];
                } catch { return []; }
            }) : [];
            list.sort((a,b)=>b.createdAt-a.createdAt);
            json(200,list); return true;
        }
        if (req.url === '/voices' && req.method === 'POST') {
            if (req.headers.origin !== 'http://' + req.headers.host || req.headers['x-voice-consent'] !== 'yes') {
                json(403,{error:'Confirm permission to use this voice in the local app.'}); return true;
            }
            const chunks=[];let bytes=0;
            for await (const chunk of req) {
                bytes+=chunk.length;
                if (bytes>6*1024*1024) {json(413,{error:'Recording is too large. Record up to 60 seconds.'});return true;}
                chunks.push(chunk);
            }
            const audio=Buffer.concat(chunks);
            const duration=validateWav(audio);
            const name=decodeURIComponent(req.headers['x-voice-name'] || '').trim();
            if (!name || name.length>80) throw bad('Give this voice a name of 1–80 characters.');
            const item={id:randomUUID(),name,duration,createdAt:Date.now(),consent:true};
            fs.mkdirSync(directory,{recursive:true});
            fs.writeFileSync(path.join(directory,item.id+'.wav'),audio,{flag:'wx'});
            fs.writeFileSync(path.join(directory,item.id+'.json'),JSON.stringify(item),{flag:'wx'});
            json(201,item);return true;
        }
        const match=req.url.match(/^\/voices\/([a-f0-9-]{36})\.wav$/);
        if (req.method==='GET' && match) {
            const filename=getVoiceFile(match[1]);
            const audio=fs.readFileSync(filename);
            res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':audio.length,'Cache-Control':'no-store'});
            res.end(audio);return true;
        }
        json(404,{error:'Voice recording not found.'});
    } catch(error) {json(error.statusCode || 500,{error:error.message});}
    return true;
}
return {handle,getVoiceFile,validateWav};
}
module.exports={createVoiceStore,validateWav};
