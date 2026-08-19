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
const { spawn } = require("child_process");
require('opusscript');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

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

function loginAllBots() {
    if (dashboardTokens.length === 0) return;
    for (let i = 0; i < dashboardTokens.length; i++) {
        const token = dashboardTokens[i];
        if (!token || token.length < 50) continue;
        const client = new Client({ checkUpdate: false });
        client.once('ready', () => {
            console.log(`✅ Bot ${i + 1} online as ${client.user.tag}`);
            clients.push(client);
            io.emit('bot-started', { count: clients.length });
        });
        client.login(token).catch(err => console.log(`❌ Bot ${i + 1} failed: ${err.message}`));
    }
}

io.on('connection', (socket) => {
    console.log('📶 Dashboard connected');

    socket.on('start_bot_with_tokens', (data) => {
        const { tokens: newTokens } = data;
        if (newTokens && newTokens.length > 0) {
            // MOBILE PASTE FIX: Reassemble tokens split by line wraps
            const raw = newTokens.join('\n');
            const cleaned = raw
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map(t => t.trim())
                .filter(t => t.length > 50); // Only take valid full tokens
            dashboardTokens = cleaned;
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

    // --- RENDER UDP BYPASS PIPELINE WITH DELAY ---
    socket.on('play_song', async (url) => {
        if (!currentChannelId) {
            socket.emit('log_event', { msg: '❌ Join a VC first.', type: 'error' });
            return;
        }

        socket.emit('log_event', { msg: '🎧 Initializing bypass...', type: 'info' });

        try {
            // Force a small delay to let Render's proxy arms settle
            await new Promise(r => setTimeout(r, 3000));

            const stream = ytdl(url, {
                filter: 'audioonly',
                quality: 'lowestaudio',
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,*/*;q=0.8'
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

            // Send a silent empty audio tick to unlock the UDP stream
            setTimeout(() => {
                clients.forEach((client, index) => {
                    const player = players.get(index);
                    if (player) {
                        const tick = createAudioResource(Buffer.from([0]), { inputType: StreamType.Raw, inlineVolume: true });
                        player.play(tick);
                        setTimeout(() => player.stop(), 100);
                    }
                });
            }, 2000);

            socket.emit('log_event', { msg: '🔓 Render Bypass Active - Audio unlocking in 3s.', type: 'success' });

        } catch (err) {
            socket.emit('log_event', { msg: `❌ Bypass Failed: ${err.message}`, type: 'error' });
        }
    });

    socket.on('cmd', (cmd) => {
        socket.emit('log_event', { msg: `Command: ${cmd}`, type: 'info' });
        if (cmd === 'stop') { players.forEach(p => p.stop()); activeResources.clear(); }
        else if (cmd === 'pause') { players.forEach(p => p.pause()); isPaused = true; }
        else if (cmd === 'resume') { players.forEach(p => p.unpause()); isPaused = false; }
        else if (cmd === 'blast') { blastMode = !blastMode; pungiMode = false; superLoudMode = false; forceLoudMode = false; }
        else if (cmd === 'doubleblast') { blastMode = true; blastVolume = 100.0; currentVolumeMultiplier = 100.0; }
        else if (cmd === 'superloud') { superLoudMode = !superLoudMode; blastMode = false; pungiMode = false; forceLoudMode = false; }
        else if (cmd === 'forceloud') { forceLoudMode = !forceLoudMode; blastMode = false; pungiMode = false; superLoudMode = false; }
        else if (cmd === 'bassboost') { isBassboosted = !isBassboosted; }
        else if (cmd === 'pungi') { pungiMode = !pungiMode; blastMode = false; superLoudMode = false; forceLoudMode = false; }
        else if (cmd === 'loop') { loopMode = !loopMode; }
        else if (cmd === 'leave') { players.forEach(p => p.stop()); connections.forEach(c => c.destroy()); connections.clear(); players.clear(); activeResources.clear(); currentUrl = null; currentChannelId = null; }
    });

    socket.on('start_bots', () => {});
    socket.on('stop_bots', () => { players.forEach(p => p.stop()); activeResources.clear(); });
    socket.on('update_volume', (vol) => { currentVolumeMultiplier = vol / 100; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 RINTU ULTRA DASHBOARD LIVE on ${PORT}`));
