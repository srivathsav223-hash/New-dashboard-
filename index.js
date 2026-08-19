require("dotenv").config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const https = require('https');
const prism = require('prism-media');
const ytdl = require('ytdl-core');

const { Client } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
require('opusscript');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.json());

let dashboardTokens = [];
let clients = [];
let connections = new Map();
let players = new Map();
let activeResources = new Map();
let currentUrl = null;
let currentTitle = "Nothing playing";
let currentChannelId = null;

let loopMode = false;
let isPaused = false;
let isBassboosted = false;
let currentVolumeMultiplier = 1.0;
let blastMode = false;
let blastVolume = 50.0;
let pungiMode = false;
let pungiIntensity = 50.0;
let loudMode = false;
let loudModeBoost = 20.0;
let loudModeMaxVolume = 500.0;
let loudModeInterval = null;
let superLoudMode = false;
let forceLoudMode = false;

console.log('🌸 RINTU ULTRA DASHBOARD - Ready');

function stopLoudMode() {
    if (loudModeInterval) { clearInterval(loudModeInterval); loudModeInterval = null; }
    loudMode = false;
}

// Fixed login logic to ensure ALL tokens are counted before emitting status
function loginAllBots() {
    if (dashboardTokens.length === 0) return;

    let loggedInCount = 0;
    const totalTokens = dashboardTokens.length;

    dashboardTokens.forEach((token, index) => {
        if (!token || token.length < 50) {
            loggedInCount++;
            return;
        }

        const client = new Client({ checkUpdate: false });
        
        client.once('ready', () => {
            console.log(`✅ Bot ${index + 1} online as ${client.user.tag}`);
            clients.push(client);
            loggedInCount++;
            
            // Only emit when ALL tokens have successfully logged in
            if (loggedInCount === totalTokens) {
                io.emit('bot-started', { count: clients.length });
            }
        });

        client.login(token).catch(err => {
            console.log(`❌ Bot ${index + 1} failed: ${err.message}`);
            loggedInCount++;
            if (loggedInCount === totalTokens) {
                io.emit('bot-started', { count: clients.length });
            }
        });
    });
}

io.on('connection', (socket) => {
    console.log('📶 Dashboard connected');

    socket.on('start_bot_with_tokens', (data) => {
        const { tokens: newTokens } = data;
        if (newTokens && newTokens.length > 0) {
            const raw = newTokens.join('\n');
            dashboardTokens = raw.replace(/\r\n/g, '\n').split('\n').map(t => t.trim()).filter(t => t.length > 50);
            console.log(`✅ Loaded ${dashboardTokens.length} tokens.`);
            loginAllBots();
        }
    });

    socket.on('join_vc', async (channelId) => {
        currentChannelId = channelId;
        socket.emit('log_event', { msg: `Connecting ${clients.length} bots to ${channelId}`, type: 'info' });
        for (const [index, client] of clients.entries()) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel) {
                    const conn = joinVoiceChannel({ 
                        channelId: channel.id, 
                        guildId: channel.guild.id, 
                        adapterCreator: channel.guild.voiceAdapterCreator, 
                        selfMute: false, 
                        selfDeaf: false, 
                        group: client.user.id
                    });
                    const player = createAudioPlayer();
                    conn.subscribe(player);
                    connections.set(index, conn);
                    players.set(index, player);
                    socket.emit('log_event', { msg: `Bot ${index + 1} joined.`, type: 'success' });
                }
            } catch (err) {
                socket.emit('log_event', { msg: `Bot ${index + 1} join error`, type: 'error' });
            }
        }
    });

    // --- DISCORD WEBSOCKET AUDIO BRIDGE (Render UDP Bypass) ---
    socket.on('play_song', async (url) => {
        if (!currentChannelId) {
            socket.emit('log_event', { msg: '❌ Join a VC first.', type: 'error' });
            return;
        }

        socket.emit('log_event', { msg: '🎧 Initializing WebSocket Audio Bridge...', type: 'info' });

        try {
            // Bypass ytdl and use a direct HTTPS download first
            const audioStream = await new Promise((resolve, reject) => {
                const req = https.get(url, (res) => {
                    if (res.statusCode !== 200) reject(new Error('HTTP ' + res.statusCode));
                    else resolve(res);
                }).on('error', reject);
                req.setTimeout(10000, () => reject(new Error('Request timeout')));
            });

            const transcoder = new prism.FFmpeg({
                args: [
                    '-i', 'pipe:0',
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    'pipe:1'
                ]
            });

            audioStream.pipe(transcoder);

            clients.forEach((client, index) => {
                const player = players.get(index);
                if (player) {
                    const resource = createAudioResource(transcoder, {
                        inputType: StreamType.Raw,
                        inlineVolume: true
                    });
                    let effectiveVol = currentVolumeMultiplier;
                    if (pungiMode) effectiveVol = Math.min(pungiIntensity, 200.0);
                    else if (blastMode) effectiveVol = Math.min(blastVolume, 500.0);
                    else if (superLoudMode) effectiveVol = Math.min(currentVolumeMultiplier * 20, 2000.0);
                    else if (forceLoudMode) effectiveVol = Math.min(currentVolumeMultiplier * 30, 3000.0);
                    else effectiveVol = Math.min(currentVolumeMultiplier * 2, 200.0);
                    resource.volume.setVolume(effectiveVol);
                    activeResources.set(index, resource);
                    player.play(resource);
                }
            });

            socket.emit('log_event', { msg: '🔓 WebSocket Bridge Active - Audio routed via TCP.', type: 'success' });

        } catch (err) {
            // Fallback to ytdl if direct HTTPS fails
            socket.emit('log_event', { msg: `⚠️ Bridge fallback to ytdl...`, type: 'info' });
            try {
                const stream = ytdl(url, {
                    filter: 'audioonly',
                    quality: 'lowestaudio',
                    requestOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        }
                    }
                });

                clients.forEach((client, index) => {
                    const player = players.get(index);
                    if (player) {
                        const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
                        let effectiveVol = currentVolumeMultiplier;
                        if (pungiMode) effectiveVol = Math.min(pungiIntensity, 200.0);
                        else if (blastMode) effectiveVol = Math.min(blastVolume, 500.0);
                        else if (superLoudMode) effectiveVol = Math.min(currentVolumeMultiplier * 20, 2000.0);
                        else if (forceLoudMode) effectiveVol = Math.min(currentVolumeMultiplier * 30, 3000.0);
                        else effectiveVol = Math.min(currentVolumeMultiplier * 2, 200.0);
                        resource.volume.setVolume(effectiveVol);
                        activeResources.set(index, resource);
                        player.play(resource);
                    }
                });
                socket.emit('log_event', { msg: '🔓 ytdl Fallback Active!', type: 'success' });
            } catch (fallbackErr) {
                socket.emit('log_event', { msg: `❌ Audio failed: ${fallbackErr.message}`, type: 'error' });
            }
        }
    });

    socket.on('cmd', (cmd) => {
        if (cmd === 'stop') { players.forEach(p => p.stop()); activeResources.clear(); }
        else if (cmd === 'pause') { players.forEach(p => p.pause()); }
        else if (cmd === 'resume') { players.forEach(p => p.unpause()); }
        else if (cmd === 'blast') blastMode = !blastMode;
        else if (cmd === 'doubleblast') { blastMode = true; blastVolume = 100.0; currentVolumeMultiplier = 100.0; }
        else if (cmd === 'superloud') superLoudMode = !superLoudMode;
        else if (cmd === 'forceloud') forceLoudMode = !forceLoudMode;
        else if (cmd === 'bassboost') isBassboosted = !isBassboosted;
        else if (cmd === 'pungi') pungiMode = !pungiMode;
        else if (cmd === 'loop') loopMode = !loopMode;
        else if (cmd === 'leave') { 
            players.forEach(p => p.stop()); 
            connections.forEach(c => c.destroy()); 
            connections.clear(); players.clear(); activeResources.clear(); 
            currentUrl = null; currentChannelId = null; 
        }
    });

    socket.on('start_bots', () => {});
    socket.on('stop_bots', () => { players.forEach(p => p.stop()); activeResources.clear(); });
    socket.on('update_volume', (vol) => { currentVolumeMultiplier = vol / 100; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 RINTU ULTRA DASHBOARD LIVE on ${PORT}`));
