const http = require('http');
const fs = require('fs');
const path = require('path');
const Replicate = require('replicate');

const PORT = 3000;

// TODO: Paste your funded Replicate token starting with r8_ here!
// This tells the global cloud server to read your key safely out of hidden memory
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;  

const replicate = new Replicate({
  auth: REPLICATE_API_TOKEN,
});

async function downloadAudioBuffer(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, content) => {
            if (err) {
                res.writeHead(500); res.end("Missing index.html"); return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
    } else if (req.method === 'POST' && req.url === '/generate') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const inputData = JSON.parse(body);
                const fullLyrics = inputData.lyrics;
                
                let lyricChunks = [];
                let currentChunk = "";
                const lines = fullLyrics.split('\n');

                // ADVANCED LOOP SLICER: Packages lines into groups safely below 450 characters
                for (let line of lines) {
                    if ((currentChunk + "\n" + line).length > 450) {
                        if (currentChunk.trim().length >= 10) {
                            lyricChunks.push(currentChunk.trim());
                        }
                        currentChunk = line;
                    } else {
                        currentChunk += (currentChunk === "" ? "" : "\n") + line;
                    }
                }
                if (currentChunk.trim().length >= 10) {
                    lyricChunks.push(currentChunk.trim());
                }

                console.log(`📋 Bulletproof Slicer: Split text into ${lyricChunks.length} safe blocks.`);
                let completedAudioBuffers = [];

                // PROCESS QUEUE: Executes segments consecutively
                for (let i = 0; i < lyricChunks.length; i++) {
                    console.log(`🚀 Rendering chunk ${i + 1} of ${lyricChunks.length}... (${lyricChunks[i].length} chars)`);
                    
                    let prediction = await replicate.predictions.create({
                        model: "minimax/music-1.5",
                        input: {
                            prompt: inputData.prompt,
                            lyrics: lyricChunks[i]
                        }
                    });

                    let result = await replicate.wait(prediction);
                    let chunkUrl = "";

                    if (result.status === "succeeded" && result.output) {
                        const out = result.output;
                        if (typeof out === 'string') chunkUrl = out;
                        else if (Array.isArray(out) && out.length > 0) chunkUrl = out[0];
                        else if (typeof out === 'object') chunkUrl = out.audio || out.url || Object.values(out)[0];
                    }

                    if (!chunkUrl) throw new Error(`Segment ${i + 1} failed processing.`);

                    console.log(`📥 Downloading segment ${i + 1}...`);
                    const audioBuffer = await downloadAudioBuffer(chunkUrl);
                    completedAudioBuffers.push(audioBuffer);
                }

                console.log("🎛️ Stitching everything together...");
                const finalStitchedBuffer = Buffer.concat(completedAudioBuffers);
                
                const outputFilename = `mastered-song-${Date.now()}.mp3`;
                fs.writeFileSync(path.join(__dirname, outputFilename), finalStitchedBuffer);

                console.log(`🎉 SUCCESS! Whole song saved as: ${outputFilename}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ audioUrl: `/${outputFilename}` }));

            } catch (err) {
                console.error("Pipeline failure:", err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else if (req.method === 'GET' && req.url.endsWith('.mp3')) {
        const filePath = path.join(__dirname, req.url);
        if (fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': 'audio/mp3' });
            fs.createReadStream(filePath).pipe(res);
        } else { res.writeHead(404); res.end(); }
    } else { res.writeHead(404); res.end(); }
});

server.listen(PORT, () => {
    console.log(`🚀 Bulletproof Production Matrix is live at http://localhost:${PORT}`);
});
