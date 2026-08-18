const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Client } = require("discord.js-selfbot-v13");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.json());

let dashboardTokens = [];
let isBotRunning = false;
let clients = [];

console.log('🌸 RINTU DASHBOARD - Ready for tokens');

function startBots() {
    if (isBotRunning) return console.log('⚠️ Bots already running.');
    if (dashboardTokens.length === 0) return console.log('❌ No tokens loaded.');
    isBotRunning = true;
    for (let i = 0; i < dashboardTokens.length; i++) {
        const token = dashboardTokens[i];
        const client = new Client();
        client.once('ready', () => {
            console.log(`✅ Bot ${i + 1} online as ${client.user.tag}`);
            clients.push(client);
            io.emit('bot-started', { count: clients.length });
        });
        client.login(token).catch(err => console.log(`❌ Bot ${i + 1} failed: ${err.message}`));
    }
}

function stopBots() {
    isBotRunning = false;
    clients.forEach(c => c.destroy());
    clients = [];
    io.emit('bot-stopped');
}

io.on('connection', (socket) => {
    console.log('📶 Dashboard connected');

    socket.on('start_bot_with_tokens', (data) => {
        const { tokens: newTokens } = data;
        if (newTokens && newTokens.length > 0) {
            dashboardTokens = newTokens.filter(t => t && t.length > 10);
            console.log(`✅ Loaded ${dashboardTokens.length} tokens.`);
            startBots();
        } else {
            console.log('❌ No valid tokens received');
        }
    });

    socket.on('start_bots', () => startBots());
    socket.on('stop_bots', () => stopBots());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 RINTU DASHBOARD LIVE on port ${PORT}`));
