require("dotenv").config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Client } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const { spawn } = require("child_process");
const youtubedl = require("youtube-dl-exec");

// --- WEB SERVER (Loads the Dashboard) ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.json());

// --- BOT GLOBALS ---
let dashboardTokens = [];
let clients = [];
let connections = new Map();
let players = new Map();
let activeResources = new Map();
let currentFFmpegProcess = null;
let currentUrl = null;
let currentTitle = "Nothing playing";
let currentChannelId = null;

// --- TOGGLES ---
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

// --- HELPER FUNCTIONS ---
function stopFFmpeg() {
    if (currentFFmpegProcess) { try { currentFFmpegProcess.kill("SIGKILL"); } catch (e) {} currentFFmpegProcess = null; }
}

function stopLoudMode() {
    if (loudModeInterval) { clearInterval(loudModeInterval); loudModeInterval = null; }
    loudMode = false;
}

// --- START FFMPEG STREAM ---
function startFFmpegStream(inputSource) {
    stopFFmpeg();
    let audioFilters = [];
    if (superLoudMode) {
        audioFilters.push("volume=15dB", "acompressor=threshold=0.05:ratio=20:attack=5:release=50", "alimiter=level_in=15:level_out=0:limit=0.99:attack=1:release=50", "dynaudnorm=p=0.95:m=100:g=20", "volume=amplitude=8");
    }
    if (forceLoudMode) {
        audioFilters.push("compand=attacks=0.001:decays=0.001:points=-80/-80|-40/-25|-20/-10|0/-5|10/-2|20/0|30/5", "volume=20dB", "dynaudnorm=p=1:m=100:g=30", "aecho=0.8:0.9:1000:0.3");
    }
    if (isBassboosted) audioFilters.push("equalizer=f=60:width_type=h:width=50:g=15");
    if (pungiMode) {
        audioFilters.push("acrusher=bits=4:mode=log:aa=1", "equalizer=f=30:width_type=h:width=80:g=20", "equalizer=f=1000:width_type=h:width=500:g=10", `volume=${pungiIntensity}`, "aphaser=0.8:0.8:2000:0.4", "aecho=0.8:0.9:1000:0.3");
    } else if (blastMode) {
        audioFilters.push(`volume=${blastVolume}`, "dynaudnorm=p=0.9:m=50.0:g=15", "alimiter=level_in=2.0:level_out=0.98:limit=0.99:attack=5:release=50");
    } else {
        if (currentVolumeMultiplier > 1.0) audioFilters.push(`volume=${currentVolumeMultiplier}`);
    }

    currentFFmpegProcess = spawn("ffmpeg", ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", inputSource, "-filter:a", audioFilters.join(","), "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]);

    clients.forEach((client, index) => {
        const player = players.get(index);
        if (player && currentFFmpegProcess) {
            const resource = createAudioResource(currentFFmpegProcess.stdout, { inputType: StreamType.Raw, inlineVolume: true });
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
    isPaused = false;
}

// --- LOGIN BOTS ---
function loginAllBots() {
    if (dashboardTokens.length === 0) return;
    for (let i = 0; i < dashboardTokens.length; i++) {
        const token = dashboardTokens[i];
        const client = new Client({ checkUpdate: false });
        client.once('ready', () => {
            console.log(`✅ Bot ${i + 1} online as ${client.user.tag}`);
            clients.push(client);
            io.emit('bot-started', { count: clients.length });
        });
        client.login(token).catch(err => console.log(`❌ Bot ${i + 1} failed: ${err.message}`));
    }
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
    console.log('📶 Dashboard connected');

    socket.on('start_bot_with_tokens', (data) => {
        const { tokens: newTokens } = data;
        if (newTokens && newTokens.length > 0) {
            dashboardTokens = newTokens.filter(t => t && t.length > 10);
            console.log(`✅ Loaded ${dashboardTokens.length} tokens.`);
            loginAllBots();
        }
    });

    // JOIN VOICE CHANNEL
    socket.on('join_vc', async (channelId) => {
        currentChannelId = channelId;
        socket.emit('log_event', { msg: `Connecting ${clients.length} bots to ${channelId}`, type: 'info' });
        for (const [index, client] of clients.entries()) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel) {
                    const conn = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfMute: false, selfDeaf: false, group: client.user.id });
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

    // --- NEW ADDITION: PLAY SONG FROM DASHBOARD ---
    socket.on('play_song', async (url) => {
        if (!currentChannelId) {
            socket.emit('log_event', { msg: '❌ Join a voice channel first!', type: 'error' });
            return;
        }
        socket.emit('log_event', { msg: `🎵 Fetching audio from URL...`, type: 'info' });
        try {
    const result = await youtubedl(url, {
        dumpSingleJson: true,
        noPlaylist: true,
        format: "bestaudio[ext=webm]/bestaudio/best",
        noWarnings: true,
        cookies: 'cookies.txt'  // <--- ADD THIS LINE
    });
    currentUrl = result.url;
    currentTitle = result.title || "YouTube Audio";
    socket.emit('song_playing', currentTitle);
    startFFmpegStream(currentUrl);
} catch (err) {
    socket.emit('log_event', { msg: `❌ Error extracting audio: ${err.message}`, type: 'error' });
        }
    });

    // ADVANCED COMMANDS (Blast, Pungi, Loop, etc.)
    socket.on('cmd', (cmd) => {
        socket.emit('log_event', { msg: `Command: ${cmd}`, type: 'info' });
        if (cmd === 'stop') { stopFFmpeg(); players.forEach(p => p.stop()); activeResources.clear(); }
        else if (cmd === 'pause') { players.forEach(p => p.pause()); isPaused = true; }
        else if (cmd === 'resume') { players.forEach(p => p.unpause()); isPaused = false; }
        else if (cmd === 'blast') { blastMode = !blastMode; pungiMode = false; superLoudMode = false; forceLoudMode = false; socket.emit('log_event', { msg: `Blast: ${blastMode}`, type: 'info' }); if(currentUrl) startFFmpegStream(currentUrl); }
        else if (cmd === 'doubleblast') { blastMode = true; blastVolume = 100.0; currentVolumeMultiplier = 100.0; socket.emit('log_event', { msg: `Double Blast ACTIVATED!`, type: 'success' }); if(currentUrl) startFFmpegStream(currentUrl); }
        else if (cmd === 'superloud') { superLoudMode = !superLoudMode; blastMode = false; pungiMode = false; forceLoudMode = false; socket.emit('log_event', { msg: `Super Loud: ${superLoudMode}`, type: 'info' }); if(currentUrl) startFFmpegStream(currentUrl); }
        else if (cmd === 'forceloud') { forceLoudMode = !forceLoudMode; blastMode = false; pungiMode = false; superLoudMode = false; socket.emit('log_event', { msg: `Force Loud: ${forceLoudMode}`, type: 'info' }); if(currentUrl) startFFmpegStream(currentUrl); }
        else if (cmd === 'bassboost') { isBassboosted = !isBassboosted; socket.emit('log_event', { msg: `Bassboost: ${isBassboosted}`, type: 'info' }); if(currentUrl) startFFmpegStream(currentUrl); }
        else if (cmd === 'pungi') { pungiMode = !pungiMode; blastMode = false; superLoudMode = false; forceLoudMode = false; socket.emit('log_event', { msg: `Pungi: ${pungiMode}`, type: 'info' }); if(currentUrl) startFFmpegStream(currentUrl); }
        else if (cmd === 'loop') { loopMode = !loopMode; socket.emit('log_event', { msg: `Loop: ${loopMode}`, type: 'info' }); }
        else if (cmd === 'leave') { stopFFmpeg(); players.forEach(p => p.stop()); connections.forEach(c => c.destroy()); connections.clear(); players.clear(); activeResources.clear(); currentUrl = null; currentChannelId = null; }
    });

    socket.on('start_bots', () => { if(currentUrl && clients.length > 0) startFFmpegStream(currentUrl); });
    socket.on('stop_bots', () => { stopFFmpeg(); players.forEach(p => p.stop()); activeResources.clear(); });
    socket.on('update_volume', (vol) => { currentVolumeMultiplier = vol / 100; if(currentUrl) startFFmpegStream(currentUrl); });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 RINTU ULTRA DASHBOARD LIVE on ${PORT}`));
