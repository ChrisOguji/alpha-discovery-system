import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import * as http from 'http';

dotenv.config();

// 1. Minimal HTTP server to keep Render happy
const PORT = parseInt(process.env.PORT || '3000', 10);
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running');
}).listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));

// 2. Initialize Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

// 3. Launch with dropPendingUpdates to prevent 409 Conflicts
// Remove the bot.stop() call to avoid race conditions
bot.launch({
    dropPendingUpdates: true
}).then(() => {
    console.log("🤖 Bot successfully launched!");
}).catch((err) => {
    console.error("Launch Error:", err);
    process.exit(1); // Force exit if it can't start
});

// 4. Basic test handler
bot.command('test', (ctx) => ctx.reply('Bot is online.'));
