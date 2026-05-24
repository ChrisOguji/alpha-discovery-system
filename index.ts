import axios from 'axios';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as http from 'http'; // Added for Free Web Service support

dotenv.config();

// ==========================================
// TYPES & INTERFACES
// ==========================================
interface Account {
  username: string;
  is_manual_seed: boolean;
  priority_tier: 'HIGH' | 'MEDIUM' | 'LOW';
  reputation_score: number;
  last_scanned: Date;
}

interface InteractionEdge {
  source: string;
  target: string;
  interaction_type: 'quote' | 'reply' | 'co_mention';
  weight: number;
  timestamp: Date;
}

interface TokenSignal {
  token_address: string;
  ticker: string;
  mentioned_by: string;
  timestamp: Date;
  initial_price_usd: number;
  peak_multiplier: number;
}

// ==========================================
// DATABASE SCHEMA INITIALIZATION
// ==========================================
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      username TEXT PRIMARY KEY,
      is_manual_seed BOOLEAN DEFAULT FALSE,
      priority_tier TEXT DEFAULT 'LOW',
      reputation_score NUMERIC DEFAULT 50.0,
      last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS interaction_edges (
      id SERIAL PRIMARY KEY,
      source TEXT REFERENCES accounts(username) ON DELETE CASCADE,
      target TEXT,
      interaction_type TEXT,
      weight INT DEFAULT 1,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_interaction UNIQUE (source, target, interaction_type)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS token_signals (
      id SERIAL PRIMARY KEY,
      token_address TEXT,
      ticker TEXT,
      mentioned_by TEXT REFERENCES accounts(username) ON DELETE CASCADE,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      initial_price_usd NUMERIC,
      peak_multiplier NUMERIC DEFAULT 1.0,
      CONSTRAINT unique_token_mention UNIQUE (token_address, mentioned_by)
    );
  `);
  
  console.log("⚡ Database Schema and Constraints Initialized Successfully.");
}

// ==========================================
// X/TWITTER & MARKET API INTEGRATION
// ==========================================
const xApi = axios.create({
  baseURL: 'https://api.twitter.com/2',
  headers: { Authorization: `Bearer ${process.env.X_API_KEY}` }
});

async function fetchRecentMentionsAndTweets(username: string) {
  try {
    return [
      { text: "Looking into $SOL alpha project @NewAlphaHunter", type: "quote", target: "NewAlphaHunter", token: "SRMuox7w72EwBTwD6VZu9mYZK6C5vD866pBfAtH88x4" },
      { text: "Massive accumulation on this one", type: "co_mention", target: "WhaleTraderX", token: "SRMuox7w72EwBTwD6VZu9mYZK6C5vD866pBfAtH88x4" }
    ];
  } catch (error) {
    console.error(`Error fetching data for ${username}`);
    return [];
  }
}

async function getPriceFromDexScreener(tokenAddress: string): Promise<number> {
  try {
    const res = await axios.get(`${process.env.DEXSCREENER_API_URL}/pairs/solana/${tokenAddress}`);
    return res.data.pair?.priceUsd ? parseFloat(res.data.pair.priceUsd) : 0;
  } catch (error) {
    console.error(`DexScreener connection timeout/error for: ${tokenAddress}`);
    return 0;
  }
}

// ==========================================
// ALGORITHMIC ENGINE (REPUTATION & DISCOVERY)
// ==========================================
async function runAutonomousDiscovery() {
  console.log("🔍 Scanning seed accounts to discover new networks...");
  const seeds = await db.query("SELECT username FROM accounts WHERE priority_tier = 'HIGH' OR is_manual_seed = TRUE");
  
  for (const seed of seeds.rows) {
    const activities = await fetchRecentMentionsAndTweets(seed.username);
    for (const act of activities) {
      await db.query(`
        INSERT INTO accounts (username, is_manual_seed, priority_tier, reputation_score)
        VALUES ($1, FALSE, 'LOW', 30.0)
        ON CONFLICT (username) DO NOTHING
      `, [act.target]);

      await db.query(`
        INSERT INTO interaction_edges (source, target, interaction_type, weight)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT ON CONSTRAINT unique_interaction DO UPDATE 
        SET weight = interaction_edges.weight + 1, timestamp = CURRENT_TIMESTAMP
      `, [seed.username, act.target, act.type]);

      if (act.token) {
        const currentPrice = await getPriceFromDexScreener(act.token);
        if (currentPrice > 0) {
          await db.query(`
            INSERT INTO token_signals (token_address, ticker, mentioned_by, initial_price_usd)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT ON CONSTRAINT unique_token_mention DO NOTHING
          `, [act.token, 'SOL_TOKEN', seed.username, currentPrice]);
        }
      }
    }
  }
  await promoteHighDensityAccounts();
}

async function promoteHighDensityAccounts() {
  const highDensity = await db.query(`
    SELECT target, COUNT(DISTINCT source) as unique_interactions
    FROM interaction_edges
    GROUP BY target
    HAVING COUNT(DISTINCT source) >= 3
  `);

  for (const row of highDensity.rows) {
    await db.query(`
      UPDATE accounts 
      SET priority_tier = 'MEDIUM', reputation_score = LEAST(100.0, reputation_score + 5)
      WHERE username = $1 AND priority_tier = 'LOW'
    `, [row.target]);
    console.log(`📈 Promoted ${row.target} to MEDIUM tier due to high engagement overlap.`);
  }
}

async function updateReputationScores() {
  console.log("⚖️ Recalculating dynamic reputation scores based on market outcomes...");
  const activeSignals = await db.query("SELECT * FROM token_signals");

  for (const signal of activeSignals.rows) {
    const freshPrice = await getPriceFromDexScreener(signal.token_address);
    if (freshPrice === 0 || !signal.initial_price_usd) continue;

    const currentMultiplier = freshPrice / parseFloat(signal.initial_price_usd);
    if (currentMultiplier > parseFloat(signal.peak_multiplier)) {
      await db.query("UPDATE token_signals SET peak_multiplier = $1 WHERE id = $2", [currentMultiplier, signal.id]);
    }

    if (currentMultiplier >= 3.0) {
      await db.query("UPDATE accounts SET reputation_score = LEAST(100.0, reputation_score + 10) WHERE username = $1", [signal.mentioned_by]);
    } else if (currentMultiplier < 0.4) {
      await db.query("UPDATE accounts SET reputation_score = GREATEST(0.0, reputation_score - 15) WHERE username = $1", [signal.mentioned_by]);
    }
  }
}

async function seedManualWatchlist(usernames: string[]) {
  for (const username of usernames) {
    await db.query(`
      INSERT INTO accounts (username, is_manual_seed, priority_tier, reputation_score)
      VALUES ($1, TRUE, 'HIGH', 75.0)
      ON CONFLICT (username) DO UPDATE SET is_manual_seed = TRUE, priority_tier = 'HIGH'
    `, [username]);
  }
  console.log(`🌱 Seeded ${usernames.length} high-value accounts into the core watchlist.`);
}

// ==========================================
// SYSTEM EXECUTIVE RUNNER WITH WEB PORT
// ==========================================
async function main() {
  await initDatabase();

  const initialCuratedList = ['0xFluid', 'solana_alpha_caller', 'intern'];
  await seedManualWatchlist(initialCuratedList);

  // Discovery engine loop (15 mins)
  setInterval(async () => {
    try { await runAutonomousDiscovery(); } catch (err) { console.error(err); }
  }, 1000 * 60 * 15);

  // Analytics re-index loop (30 mins)
  setInterval(async () => {
    try { await updateReputationScores(); } catch (err) { console.error(err); }
  }, 1000 * 60 * 30);

  // DUMMY HTTP SERVER TO KEEP RENDER FREE TIER HAPPY
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Alpha System Active\n');
  }).listen(port, () => {
    console.log(`🌍 Keeping service alive on port ${port}`);
  });
}

main().catch(console.error);
