import axios from 'axios';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as http from 'http';

dotenv.config();

// ==========================================
// DATABASE POOL WITH SSL & RECONNECT LOGIC
// ==========================================
const db = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for secure cloud DBs like Neon/Supabase
});

async function initDatabase() {
  try {
    // Accounts table tracking discovered alpha profiles
    await db.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        username TEXT PRIMARY KEY,
        priority_tier TEXT DEFAULT 'LOW',
        reputation_score NUMERIC DEFAULT 50.0,
        total_signals_tracked INT DEFAULT 0,
        last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Token signals mapped to the usernames listed in their metadata
    await db.query(`
      CREATE TABLE IF NOT EXISTS token_signals (
        id SERIAL PRIMARY KEY,
        token_address TEXT,
        ticker TEXT,
        discovered_via_account TEXT REFERENCES accounts(username) ON DELETE CASCADE,
        initial_price_usd NUMERIC,
        current_price_usd NUMERIC,
        peak_multiplier NUMERIC DEFAULT 1.0,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_token_account UNIQUE (token_address, discovered_via_account)
      );
    `);
    
    console.log("⚡ Permanent Cloud Database Initialized Successfully.");
  } catch (err) {
    console.error("❌ Database initialization failed. Retrying in 5s...", err);
    setTimeout(initDatabase, 5000);
  }
}

// ==========================================
// PUBLIC MARKET DATA INGESTION ENGINE
// ==========================================
async function discoverNewSolanaTokens() {
  try {
    const response = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    const profiles = response.data?.data || response.data;
    
    if (!Array.isArray(profiles)) return [];
    return profiles.filter((p: any) => p.chainId === 'solana' && p.links && p.tokenAddress);
  } catch (error) {
    console.error('Error fetching data pools from DexScreener API');
    return [];
  }
}

async function getLiveTokenPrice(tokenAddress: string): Promise<number> {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (res.data && res.data.pairs && res.data.pairs[0]) {
      return parseFloat(res.data.pairs[0].priceUsd || '0');
    }
    return 0;
  } catch {
    return 0;
  }
}

// ==========================================
// SYSTEM AUTOMATION LOOPS
// ==========================================
async function runAutonomousDiscovery() {
  console.log("🔍 Scanning on-chain liquidity profiles for alpha accounts...");
  const rawTokens = await discoverNewSolanaTokens();

  for (const token of rawTokens) {
    const twitterLink = token.links.find((l: any) => l.type === 'twitter' || l.url.includes('x.com') || l.url.includes('twitter.com'));
    if (!twitterLink) continue;

    let username = twitterLink.url.split('/').pop()?.replace('@', '').split('?')[0].trim().toLowerCase();
    if (!username || username === 'home' || username === 'i' || username.length < 2) continue;

    try {
      await db.query(`
        INSERT INTO accounts (username, reputation_score)
        VALUES ($1, 50.0)
        ON CONFLICT (username) DO UPDATE SET total_signals_tracked = accounts.total_signals_tracked + 1
      `, [username]);

      const initialPrice = await getLiveTokenPrice(token.tokenAddress);
      if (initialPrice === 0) continue;

      await db.query(`
        INSERT INTO token_signals (token_address, ticker, discovered_via_account, initial_price_usd, current_price_usd)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT ON CONSTRAINT unique_token_account DO NOTHING
      `, [token.tokenAddress, token.symbol || 'UNKNOWN', username, initialPrice]);
      
      console.log(`🎯 Paired Account: @${username} ➔ ${token.symbol || 'SOL'}`);
    } catch (dbErr) {
      console.error("Error writing block iteration to DB:", dbErr);
    }
  }
}

async function updateReputationScores() {
  console.log("⚖️ Re-calculating alpha dynamic performance analytics...");
  try {
    const activeSignals = await db.query("SELECT * FROM token_signals");

    for (const signal of activeSignals.rows) {
      const currentPrice = await getLiveTokenPrice(signal.token_address);
      if (currentPrice === 0) continue;

      const initialPrice = parseFloat(signal.initial_price_usd);
      const currentMultiplier = currentPrice / initialPrice;
      const historicPeak = parseFloat(signal.peak_multiplier);

      if (currentMultiplier > historicPeak) {
        await db.query("UPDATE token_signals SET peak_multiplier = $1, current_price_usd = $2 WHERE id = $3", [currentMultiplier, currentPrice, signal.id]);
      } else {
        await db.query("UPDATE token_signals SET current_price_usd = $1 WHERE id = $2", [currentPrice, signal.id]);
      }

      if (currentMultiplier >= 3.0) {
        await db.query("UPDATE accounts SET reputation_score = LEAST(100.0, reputation_score + 15.0), priority_tier = 'HIGH' WHERE username = $1", [signal.discovered_via_account]);
      } else if (currentMultiplier <= 0.3) {
        await db.query("UPDATE accounts SET reputation_score = GREATEST(0.0, reputation_score - 20.0), priority_tier = 'LOW' WHERE username = $1", [signal.discovered_via_account]);
      }
    }
  } catch (err) {
    console.error("Error running reputation calculations:", err);
  }
}

// ==========================================
// SYSTEM ENTRY INITIALIZER
// ==========================================
async function main() {
  await initDatabase();

  setInterval(async () => {
    try { await runAutonomousDiscovery(); } catch (e) { console.error(e); }
  }, 1000 * 60 * 5); // 5 mins

  setInterval(async () => {
    try { await updateReputationScores(); } catch (e) { console.error(e); }
  }, 1000 * 60 * 15); // 15 mins

  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: "healthy", engine: "alpha-discovery-v2" }));
  }).listen(port, () => {
    console.log(`🌍 Live network ping target online via port ${port}`);
  });
}

main().catch(console.error);
