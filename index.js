require("dotenv").config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Client } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const { spawn } = require("child_process");
const youtubedl = require("youtube-dl-exec");
const fs = require("fs");

// --- WEBSERVER SETUP ---
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

console.log('🌸 RINTU DASHBOARD - Ready for tokens');

// --- HELPER: STOP FFMPEG ---
function stopFFmpeg() {
    if (currentFFmpegProcess) {
        try { currentFFmpegProcess.kill("SIGKILL"); } catch (e) {}
        currentFFmpegProcess = null;
    }
}

// --- HELPER: LOUD MODE ---
function startLoudMode() {
    if (loudModeInterval) clearInterval(loudModeInterval);
    console.log("[LOUD MODE] 🔊 Monitoring active speakers...");
    loudModeInterval = setInterval(() => {
        if (!loudMode || connections.size === 0) return;
        const primaryClient = clients[0];
        if (!primaryClient || !currentChannelId) return;
        const channel = primaryClient.channels.cache.get(currentChannelId);
        if (!channel) return;
        const clusterIds = clients.map(c => c.user?.id).filter(Boolean);
        const speakingMembers = channel.members.filter(m => !clusterIds.includes(m.id) && !m.voice.selfMute && m.voice.speaking);
        const targetVolume = speakingMembers.size > 0 ? Math.min(currentVolumeMultiplier * loudModeBoost, loudModeMaxVolume) : currentVolumeMultiplier;
        activeResources.forEach((resource) => {
            if (resource && resource.volume && resource.volume.volume !== targetVolume) {
                resource.volume.setVolume(targetVolume);
            }
        });
    }, 400);
}

function stopLoudMode() {
    if (loudModeInterval) { clearInterval(loudModeInterval); loudModeInterval = null; }
    loudMode = false;
}

// --- CORE: START FFMPEG STREAM ---
function startFFmpegStream(inputSource) {
    stopFFmpeg();
    let audioFilters = [];

    if (superLoudMode) {
        audioFilters.push("compand=attacks=0.01:decays=0.01:points=-80/-80|-30/-15|-12/-6|-6/-3|0/-2|20/-1");
        audioFilters.push("volume=15dB");
        audioFilters.push("acompressor=threshold=0.05:ratio=20:attack=5:release=50");
        audioFilters.push("alimiter=level_in=15:level_out=0:limit=0.99:attack=1:release=50");
        audioFilters.push("dynaudnorm=p=0.95:m=100:g=20");
        audioFilters.push("volume=amplitude=8");
    }
    if (forceLoudMode) {
        audioFilters.push("compand=attacks=0.001:decays=0.001:points=-80/-80|-40/-25|-20/-10|0/-5|10/-2|20/0|30/5");
        audioFilters.push("acompressor=threshold=0.01:ratio=50:attack=1:release=100");
        audioFilters.push("alimiter=level_in=25:level_out=0.99:limit=1:attack=1:release=100");
        audioFilters.push("dynaudnorm=p=1:m=100:g=30");
        audioFilters.push("volume=20dB");
        audioFilters.push("aecho=0.8:0.9:1000:0.3");
    }
    if (isBassboosted) audioFilters.push("equalizer=f=60:width_type=h:width=50:g=15");
    if (pungiMode) {
        audioFilters.push("acrusher=bits=4:mode=log:aa=1");
        audioFilters.push("equalizer=f=30:width_type=h:width=80:g=20");
        audioFilters.push("equalizer=f=1000:width_type=h:width=500:g=10");
        audioFilters.push(`volume=${pungiIntensity}`);
        audioFilters.push("aphaser=0.8:0.8:2000:0.4");
        audioFilters.push("aecho=0.8:0.9:1000:0.3");
    } else if (blastMode) {
        audioFilters.push(`volume=${blastVolume}`);
        audioFilters.push("dynaudnorm=p=0.9:m=50.0:g=15");
        audioFilters.push("alimiter=level_in=2.0:level_out=0.98:limit=0.99:attack=5:release=50");
    } else {
        if (currentVolumeMultiplier > 1.0) audioFilters.push(`volume=${currentVolumeMultiplier}`);
    }

    console.log(`[AUDIO] Filters applied: ${audioFilters.join(', ')}`);

    currentFFmpegProcess = spawn("ffmpeg", [
        "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
        "-i", inputSource,
        "-filter:a", audioFilters.join(","),
        "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
    ]);

    clients.forEach((client, index) => {
        const player = players.get(index);
        if (player && currentFFmpegProcess) {
            const resource = createAudioResource(currentFFmpegProcess.stdout, {
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

    isPaused = false;
    if (loudMode) startLoudMode();
}

// --- DASHBOARD WEBSOCKET EVENTS ---
io.on('connection', (socket) => {
    console.log('📶 Dashboard connected');

    socket.on('start_bot_with_tokens', (data) => {
        const { tokens: newTokens } = data;
        if (newTokens && newTokens.length > 0) {
            dashboardTokens = newTokens.filter(t => t && t.length > 10);
            console.log(`✅ Loaded ${dashboardTokens.length} tokens.`);
            loginAllBots();
        } else {
            console.log('❌ No valid tokens received');
        }
    });

    socket.on('start_bots', () => {
        if(currentUrl && clients.length > 0 && currentChannelId) startFFmpegStream(currentUrl);
        else console.log("⚠️ Not enough data to resume playback.");
    });

    socket.on('stop_bots', () => {
        stopFFmpeg();
        stopLoudMode();
        players.forEach(p => p.stop());
        activeResources.clear();
        console.log("🔴 Playback stopped via Dashboard.");
        io.emit('bot-stopped');
    });

    socket.on('update_volume', (vol) => {
        currentVolumeMultiplier = vol / 100;
        console.log(`🎚️ Volume set to ${vol}% via Dashboard Slider.`);
        if(currentUrl && clients.length > 0) startFFmpegStream(currentUrl);
    });
});

// --- LOGIN BOTS (CLUSTER) ---
function loginAllBots() {
    if (dashboardTokens.length === 0) return console.log('❌ No tokens to login.');
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

// --- START WEB SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 RINTU DASHBOARD LIVE on port ${PORT}`));
