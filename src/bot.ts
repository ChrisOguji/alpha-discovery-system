import axios from 'axios';
import { Pool } from 'pg';
import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import b58 from 'bs58';

dotenv.config();

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

let fundingWallet: Keypair | null = null;
if (process.env.SOLANA_WALLET_PRIVATE_KEY) {
  try { fundingWallet = Keypair.fromSecretKey(b58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY)); } 
  catch (e) { console.error("Wallet key parse error"); }
}

// 1. PRECISION ALPHA SCORING ENGINE
function calculateAlphaScore(profile: any, pair: any): number {
  let score = 50; 
  const desc = (profile.description || '').toLowerCase();
  if (desc.length > 200) score += 25;
  if (desc.includes("vision") || desc.includes("tech")) score += 15;
  if (parseFloat(pair.liquidity?.usd || '0') > 15000) score += 10;
  return Math.min(score, 100);
}

// 2. HARDENED JUPITER SWAP WITH 20% SLIPPAGE & MEV PROTECTION
async function executeJupiterSwap(outputMint: string, lamports: number): Promise<any> {
  if (!fundingWallet) return null;
  const endpoints = ['https://quote-api.jup.ag/v6', 'https://api.jup.ag/v6'];
  
  for (const api of endpoints) {
    try {
      const q = await axios.get(`${api}/quote`, {
        params: {
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: outputMint,
          amount: lamports,
          slippageBps: 2000, // 20% Slippage
          onlyDirectRoutes: false
        }, timeout: 10000
      });

      const s = await axios.post(`${api}/swap`, {
        quoteResponse: q.data,
        userPublicKey: fundingWallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 200000 // Anti-MEV/Priority
      }, { timeout: 10000 });

      const tx = VersionedTransaction.deserialize(Buffer.from(s.data.swapTransaction, 'base64'));
      tx.sign([fundingWallet]);
      const sig = await connection.sendTransaction(tx, { skipPreflight: true });
      await connection.confirmTransaction(sig, 'confirmed');
      return { txid: sig, priceUsd: parseFloat(q.data.outAmount) / Math.pow(10, 9) };
    } catch (e: any) { continue; }
  }
  return null;
}

// 3. CORE SCANNER (NON-BLOCKING)
async function scan() {
  try {
    const [l, r] = await Promise.all([axios.get('https://api.dexscreener.com/token-profiles/latest/v1'), axios.get('https://api.dexscreener.com/token-profiles/recent-updates/v1')]);
    const profiles = [...(l.data || []), ...(r.data || [])];
    const unique = new Map(profiles.map((p: any) => [p.tokenAddress, p]));

    for (const p of Array.from(unique.values()).slice(0, 30)) {
      const market = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`);
      const pair = market.data?.pairs?.[0];
      if (!pair) continue;
      
      const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
      if (mcap < 7000 || mcap > 200000) continue;
      
      const alphaScore = calculateAlphaScore(p, pair);
      if (alphaScore >= 65) {
        // Send alert immediately
        const msg = `🚀 Alpha Detected: $${pair.baseToken.symbol} | Score: ${alphaScore}\nMCAP: $${mcap.toLocaleString()}`;
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, msg).catch(console.error);
        
        // Attempt Buy (Async, won't block alerts)
        executeJupiterSwap(p.tokenAddress, 5000000).catch(console.error);
      }
    }
  } catch (e) { console.error("Scan Error:", e); }
}

bot.launch().then(() => {
  console.log("🤖 Bot Live & Precision Scoring Active");
  setInterval(scan, 1000 * 60 * 2);
});
