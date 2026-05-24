import axios from 'axios';
import { Pool } from 'pg';
import { Telegraf } from 'telegraf';
import * as http from 'http';
import * as dotenv from 'dotenv';

dotenv.config();

// 1. DATABASE & TELEGRAM INITIALIZATION
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// 2. DATA STRUCTURAL INTERFACES
interface TokenSignal {
  tokenAddress: string;
  ticker: string;
  alphaScore: number;
  rugProbability: number;
  insiderRiskScore: number;
  narrativeStrength: number;
  classification: string;
}

// 3. SECURE TABLE DATABASE SCHEMA SYNCHRONIZER
async function initDatabaseSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        username TEXT PRIMARY KEY,
        priority_tier TEXT DEFAULT 'LOW',
        reputation_score NUMERIC DEFAULT 50.0,
        total_signals_tracked INT DEFAULT 0,
        last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS token_intelligence (
        token_address TEXT PRIMARY KEY,
        ticker TEXT,
        alpha_score NUMERIC DEFAULT 0.0,
        rug_probability NUMERIC DEFAULT 0.0,
        insider_risk_score NUMERIC DEFAULT 0.0,
        narrative_strength NUMERIC DEFAULT 0.0,
        classification TEXT DEFAULT 'ORGANIC',
        alert_sent BOOLEAN DEFAULT FALSE,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("🟩 Permanent Database Engine Sync Verified.");
  } catch (err) {
    console.error("❌ DB Initialization fail. Retrying...", err);
    setTimeout(initDatabaseSchema, 5000);
  }
}

// 4. CORE MATHEMATICAL INTELLIGENCE SCORING ENGINE
function calculateAlphaMetrics(pairData: any): TokenSignal {
  const liquidity = parseFloat(pairData.liquidity?.usd || '0');
  const volume24h = parseFloat(pairData.volume?.m5 || '0') * 12; // Extrapolated structural volume
  const txCount24h = (pairData.txns?.m5?.buys || 0) + (pairData.txns?.m5?.sells || 0);

  // Core logistical calculations
  let rugProbability = 0.15;
  if (liquidity < 15000) rugProbability += 0.35;
  if (txCount24h < 10) rugProbability += 0.25;

  let alphaScore = 50;
  if (volume24h > 50000) alphaScore += 25;
  if (liquidity > 30000) alphaScore += 15;
  if (rugProbability < 0.25) alphaScore += 10;

  const insiderRiskScore = liquidity < 20000 ? 45.0 : 15.0;
  const narrativeStrength = volume24h > 100000 ? 85.0 : 40.0;

  return {
    tokenAddress: pairData.baseToken.address,
    ticker: pairData.baseToken.symbol,
    alphaScore: Math.min(alphaScore, 100),
    rugProbability: Math.min(rugProbability, 1.0),
    insiderRiskScore,
    narrativeStrength,
    classification: alphaScore > 75 ? 'HIGH_POTENTIAL_RUNNER' : 'ORGANIC'
  };
}

// 5. THE ACTIVE INGESTION & SCANNING LOOP PIPELINE
async function scanSolanaTokenProfiles() {
  try {
    console.log("🔍 Extracting current token profiles from Solana stream...");
    const profileRes = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    const incomingProfiles = profileRes.data || [];

    for (const profile of incomingProfiles) {
      if (profile.chainId !== 'solana' || !profile.tokenAddress) continue;

      // Rule 1: Strict Verification of attached Twitter/X links
      const hasTwitter = profile.links?.some((l: any) => l.type === 'twitter' || l.url?.includes('x.com') || l.url?.includes('twitter.com'));
      if (!hasTwitter) continue;

      // Gather corresponding pair trading data fields
      const marketRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${profile.tokenAddress}`);
      const pairData = marketRes.data?.pairs?.[0];
      if (!pairData) continue;

      // Run mathematical alpha calculation matrix
      const metrics = calculateAlphaMetrics(pairData);

      // Check if this token was already added or alerted to avoid duplicate spam
      const checkDup = await db.query('SELECT alert_sent FROM token_intelligence WHERE token_address = $1', [profile.tokenAddress]);
      
      if (checkDup.rows.length === 0) {
        // Save the tracked entity parameters to Supabase
        await db.query(`
          INSERT INTO token_intelligence (token_address, ticker, alpha_score, rug_probability, insider_risk_score, narrative_strength, classification, alert_sent)
          VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
        `, [metrics.tokenAddress, metrics.ticker, metrics.alphaScore, metrics.rugProbability, metrics.insiderRiskScore, metrics.narrativeStrength, metrics.classification]);
      }

      // Rule 2 & 3: Strict Score Gating thresholds before alerting Telegram
      if (metrics.alphaScore >= 65 && metrics.rugProbability < 0.35) {
        const alreadyAlerted = checkDup.rows[0]?.alert_sent || false;
        
        if (!alreadyAlerted && TELEGRAM_CHAT_ID) {
          const message = `🚨 <b>AUTONOMOUS AI DEGEN CALL</b> 🚨\n\n` +
                          `<b>Token:</b> $${metrics.ticker}\n` +
                          `<b>Address:</b> <code>${metrics.tokenAddress}</code>\n\n` +
                          `📊 <b>AI Intelligence Matrix:</b>\n` +
                          `• Alpha Score: 🟢 <b>${metrics.alphaScore}/100</b>\n` +
                          `• Rug Probability: 🛡️ <b>${(metrics.rugProbability * 100).toFixed(0)}%</b>\n` +
                          `• Insider Risk: ⚠️ <b>${metrics.insiderRiskScore}%</b>\n` +
                          `• Dynamic Mode: ⚡ <code>${metrics.classification}</code>\n\n` +
                          `📱 <a href="https://dexscreener.com/solana/${metrics.tokenAddress}">Monitor Chart Live</a>`;

          // FIXED: Avoided modern property errors by using type assertions to pass compatibility tags
          await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { 
            parse_mode: 'HTML', 
            disable_web_page_preview: true 
          } as any);

          await db.query('UPDATE token_intelligence SET alert_sent = TRUE WHERE token_address = $1', [metrics.tokenAddress]);
          console.log(`🟩 Broadcast Alert successfully dispatched to Telegram for $${metrics.ticker}`);
        }
      }
    }
  } catch (err) {
    console.error("Error encountered during active token pool scan loop:", err);
  }
}

// 6. MASTER ENGINE INITIALIZER BOOTSTRAPPER
async function main() {
  await initDatabaseSchema();

  if (process.env.TELEGRAM_BOT_TOKEN) {
    bot.launch().then(() => console.log("🤖 Telegram Integration Service Online. Listening..."));
  }

  // Interval trigger scanning loops every 3 minutes
  setInterval(scanSolanaTokenProfiles, 1000 * 60 * 3);
  // Optional initial scan on startup
  scanSolanaTokenProfiles();

  // Web service listener to keep Render container port awake
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ bot: "alpha-degen-bot-v2", active: true }));
  }).listen(port, () => {
    console.log(`📡 Render Container runtime web hook listener pinned to port [${port}]`);
  });
}

main().catch(console.error);
