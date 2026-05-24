import axios from 'axios';
import { Pool } from 'pg';
import { Telegraf } from 'telegraf';
import * as http from 'http';
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

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS token_intelligence (
      token_address TEXT PRIMARY KEY,
      ticker TEXT,
      alpha_score NUMERIC,
      alert_sent BOOLEAN DEFAULT FALSE,
      bought BOOLEAN DEFAULT FALSE,
      buy_price_usd NUMERIC,
      tokens_held NUMERIC,
      highest_multiplier NUMERIC DEFAULT 1.0
    );
  `);
}

function calculateAlphaScore(profile: any, pair: any): number {
  let score = 50; 
  const desc = (profile.description || '').toLowerCase();
  if (desc.length > 200) score += 25;
  if (desc.includes("vision") || desc.includes("tech")) score += 15;
  if (parseFloat(pair.liquidity?.usd || '0') > 20000) score += 15;
  return Math.min(score, 100);
}

async function executeJupiterSwap(outputMint: string, lamports: number): Promise<any> {
  if (!fundingWallet) return null;
  const endpoints = ['https://quote-api.jup.ag/v6', 'https://api.jup.ag/v6'];
  for (const api of endpoints) {
    try {
      const q = await axios.get(`${api}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${outputMint}&amount=${lamports}&slippageBps=150`);
      const s = await axios.post(`${api}/swap`, { quoteResponse: q.data, userPublicKey: fundingWallet.publicKey.toBase58(), wrapAndUnwrapSol: true });
      const tx = VersionedTransaction.deserialize(Buffer.from(s.data.swapTransaction, 'base64'));
      tx.sign([fundingWallet]);
      await connection.sendTransaction(tx, { skipPreflight: false });
      return { priceUsd: parseFloat(q.data.outAmount) / Math.pow(10, 9) };
    } catch (e) { continue; }
  }
  return null;
}

async function scan() {
  const [l, r] = await Promise.all([axios.get('https://api.dexscreener.com/token-profiles/latest/v1'), axios.get('https://api.dexscreener.com/token-profiles/recent-updates/v1')]);
  const profiles = [...(l.data || []), ...(r.data || [])];
  for (const p of profiles.slice(0, 50)) {
    const market = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`);
    const pair = market.data?.pairs?.[0];
    if (!pair) continue;
    const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
    if (mcap < 7000 || mcap > 200000) continue;
    const alphaScore = calculateAlphaScore(p, pair);
    if (alphaScore >= 65) {
      // Logic for Telegram notification and Auto-Buy goes here...
      console.log(`🚀 Alpha Call Sent: $${pair.baseToken.symbol} | Score: ${alphaScore}`);
    }
  }
}

async function monitorPositions() {
    // Logic for -30% Stop-Loss and Tiered Take-Profit (2x, 4x, etc) goes here...
}

initDatabase().then(() => {
  setInterval(scan, 1000 * 60 * 2);
  setInterval(monitorPositions, 1000 * 30);
});
