import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// 1. Initialize Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

// 2. The Full Scanner & Trade Logic
async function scan() {
    console.log("🔍 Scanning DexScreener...");
    try {
        const { data: profiles } = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
        console.log(`Found ${profiles.length} profiles. Checking top 5...`);
        
        for (const p of profiles.slice(0, 5)) {
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`);
                const pair = data?.pairs?.[0];
                
                if (!pair) continue;

                const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
                console.log(`Checking ${pair.baseToken.symbol}: MCAP is ${mcap}`);

                if (mcap > 5000 && mcap < 500000) {
                    const msg = `🚀 Alpha: $${pair.baseToken.symbol} | MCAP: $${mcap.toLocaleString()}`;
                    await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID || '', msg);
                    console.log(`✅ Alert sent for ${pair.baseToken.symbol}`);
                }
            } catch (innerErr: any) {
                console.log(`❌ Error checking ${p.tokenAddress}: ${innerErr.message}`);
            }
        }
    } catch (e: any) { 
        console.error("Global Scan Error:", e.message); 
    }
}

// 3. Launch with conflict protection
bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log("🤖 Bot Live: Polling Started (Zombie processes cleared)");
  })
  .catch((err) => {
    console.error("Fatal Launch Error:", err);
    process.exit(1); 
  });

// 4. Test handler
bot.command('test', (ctx) => ctx.reply('Bot is online.'));

// 5. Run scanner every 60 seconds
setInterval(scan, 60000);

// ✅ ADD THESE — Graceful shutdown so Render cleanly kills old instance before new one starts
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
