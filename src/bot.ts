import axios from 'axios';
import { Pool } from 'pg';
import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import * as http from 'http';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import b58 from 'bs58';

dotenv.config();

// 1. WEB SERVER BINDING: Required for Render Web Service health checks
const PORT = parseInt(process.env.PORT || '3000', 10);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is healthy');
}).listen(PORT, '0.0.0.0', () => console.log(`🤖 Server listening on port ${PORT}`));

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

let fundingWallet: Keypair | null = null;
if (process.env.SOLANA_WALLET_PRIVATE_KEY) {
  try { fundingWallet = Keypair.fromSecretKey(b58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY)); } 
  catch (e) { console.error("Key error"); }
}

async function executeJupiterSwap(outputMint: string, lamports: number): Promise<any> {
  if (!fundingWallet) return null;
  try {
    const q = await axios.get(`https://quote-api.jup.ag/v6/quote`, {
      params: {
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: outputMint,
        amount: lamports,
        slippageBps: 2000, 
        onlyDirectRoutes: false
      }, timeout: 10000
    });

    const s = await axios.post(`https://api.jup.ag/v6/swap`, {
      quoteResponse: q.data,
      userPublicKey: fundingWallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 200000 
    }, { timeout: 10000 });

    const tx = VersionedTransaction.deserialize(Buffer.from(s.data.swapTransaction, 'base64'));
    tx.sign([fundingWallet]);
    const sig = await connection.sendTransaction(tx, { skipPreflight: true });
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  } catch (e: any) {
    console.error(`❌ Swap Failed: ${e.message}`);
    return null;
  }
}

async function scan() {
  try {
    const { data: profiles } = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    for (const p of profiles.slice(0, 10)) {
      const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`);
      const pair = data?.pairs?.[0];
      if (!pair) continue;
      
      const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
      if (mcap > 5000 && mcap < 500000) {
        console.log(`🚀 Found: ${pair.baseToken.symbol} | MCAP: ${mcap}`);
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `🚀 Alpha: $${pair.baseToken.symbol} | MCAP: ${mcap.toLocaleString()}`);
        executeJupiterSwap(p.tokenAddress, 5000000);
      }
    }
  } catch (e) { console.error("Scan error:", e); }
}

// 2. CONFLICT RESOLUTION: Ensure only one instance polls
bot.stop();
bot.launch().then(() => {
  console.log("🤖 Bot Live - Polling Started");
}).catch((err) => {
  console.error("Failed to launch bot:", err);
});

setInterval(scan, 1000 * 60 * 1);
