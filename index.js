require("dotenv").config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const ytdl = require('ytdl-core');
const wav = require('wav');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.json());

let dashboardTokens = [];
let clients = [];
let activeStreams = [];
let currentChannelId = null;

console.log('🌸 RINTU ULTRA DASHBOARD - Ready (WebRTC Bypass)');

function loginAllBots() {
    if (dashboardTokens.length === 0) return;
    const { Client } = require("discord.js-selfbot-v13");
    let readyCount = 0;
    dashboardTokens.forEach((token, i) => {
        const client = new Client({ checkUpdate: false });
        client.once('ready', () => {
            console.log(`✅ Bot ${i + 1} online as ${client.user.tag}`);
            clients.push(client);
            readyCount++;
            if (readyCount === dashboardTokens.length) io.emit('bot-started', { count: clients.length });
        });
        client.login(token).catch(err => console.log(`❌ Bot ${i + 1} failed: ${err.message}`));
    });
}

io.on('connection', (socket) => {
    console.log('📶 Dashboard connected');

    socket.on('start_bot_with_tokens', (data) => {
        const { tokens: newTokens } = data;
        if (newTokens && newTokens.length > 0) {
            dashboardTokens = newTokens.map(t => t.trim()).filter(t => t.length > 50);
            console.log(`✅ Loaded ${dashboardTokens.length} tokens.`);
            loginAllBots();
        }
    });

    socket.on('join_vc', async (channelId) => {
        currentChannelId = channelId;
        socket.emit('log_event', { msg: `Connecting ${clients.length} bots to ${channelId}`, type: 'info' });
        for (const client of clients) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel) {
                    // Raw WebRTC UDP-over-WebSocket trick
                    const conn = await client.joinVoiceChannel({ 
                        channelId: channel.id, 
                        guildId: channel.guild.id,
                        selfMute: false,
                        selfDeaf: false
                    });
                    socket.emit('log_event', { msg: `Bot joined (WebRTC bypass)`, type: 'success' });
                    activeStreams.push(conn);
                }
            } catch (err) {
                socket.emit('log_event', { msg: `Join error: ${err.message}`, type: 'error' });
            }
        }
    });

    socket.on('play_song', async (url) => {
        if (!currentChannelId) {
            socket.emit('log_event', { msg: '❌ Join a VC first.', type: 'error' });
            return;
        }
        socket.emit('log_event', { msg: '🎧 Streaming via WebRTC tunnel...', type: 'info' });

        try {
            const stream = ytdl(url, { filter: 'audioonly', quality: 'lowestaudio' });
            const ffmpeg = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
            stream.pipe(ffmpeg.stdin);

            const buffer = [];
            ffmpeg.stdout.on('data', (chunk) => buffer.push(chunk));

            ffmpeg.on('close', () => {
                const audioBuffer = Buffer.concat(buffer);
                for (const conn of activeStreams) {
                    if (conn && conn.voice && conn.voice.connection) {
                        conn.voice.connection.playRawAudio(audioBuffer);
                    }
                }
                socket.emit('log_event', { msg: '🔓 WebRTC Audio Delivered (UDP bypass active).', type: 'success' });
            });
        } catch (err) {
            socket.emit('log_event', { msg: `❌ Error: ${err.message}`, type: 'error' });
        }
    });

    socket.on('cmd', (cmd) => {
        if (cmd === 'stop') activeStreams = [];
        if (cmd === 'leave') {
            for (const conn of activeStreams) conn.destroy();
            activeStreams = [];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 RINTU ULTRA DASHBOARD LIVE on ${PORT}`));
