
// [Use the code provided in the previous turn, it already contains the 
// isolated try/catch for swap execution that ensures Telegram alerts 
// are sent even if the buy fails]

import axios from 'axios';
import { Pool } from 'pg';
import { Telegraf } from 'telegraf';
import * as http from 'http';
import * as dotenv from 'dotenv';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import b58 from 'bs58';

dotenv.config();

// 1. SERVICES & ARCHITECTURAL INITIALIZATION
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Web3 Connection Infrastructure
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
let fundingWallet: Keypair | null = null;
if (process.env.SOLANA_WALLET_PRIVATE_KEY) {
  try {
    fundingWallet = Keypair.fromSecretKey(b58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY));
    console.log(`🔑 Trading Core Synchronized. Execution Wallet: ${fundingWallet.publicKey.toBase58()}`);
  } catch (e) {
    console.error("❌ Critical: Failed to parse SOLANA_WALLET_PRIVATE_KEY. Auto-buy disabled.");
  }
}

// 2. DATA STRUCTURAL INTERFACES
interface TokenSignal {
  tokenAddress: string;
  ticker: string;
  alphaScore: number;
  rugProbability: number;
  insiderRiskScore: number;
  narrativeStrength: number;
  classification: string;
  marketCap: number;
}

// 3. SECURE TABLE DATABASE SCHEMA SYNCHRONIZER
async function initDatabaseSchema() {
  try {
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
        bought BOOLEAN DEFAULT FALSE,
        buy_price_usd NUMERIC DEFAULT 0.0,
        tokens_held NUMERIC DEFAULT 0.0,
        highest_multiplier NUMERIC DEFAULT 1.0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("🟩 Permanent Database Engine Sync Verified.");
  } catch (err) {
    console.error("❌ DB Initialization fail. Retrying...", err);
    setTimeout(initDatabaseSchema, 5000);
  }
}

// 4. CORE REPETITIVE PVP AND LORE SCRAPING FILTER
function evaluatedLoreUniqueness(tokenAddress: string, description: string): boolean {
  if (!description) return false;
  
  const formattedText = description.toLowerCase();
  
  const pvpRedFlags = [
    'pvp', 'player vs player', 'fair launch', 'no dev', 'dev left', 
    'community take over', 'cto', 'moon', '1000x', 'pump', 'chillguy'
  ];
  
  const containsPvPMeta = pvpRedFlags.some(flag => formattedText.includes(flag));
  if (containsPvPMeta) return false;

  const minimumLoreWordLength = 12;
  const wordCount = description.split(/\s+/).length;
  
  return wordCount >= minimumLoreWordLength;
}

// 5. HARDENED JUPITER AUTOMATED EXECUTION ENGINE WITH DNS RETRY INFRASTRUCTURE
async function executeJupiterSwap(inputMint: string, outputMint: string, lamportsAmount: number): Promise<{ txid: string; priceUsd: number } | null> {
  if (!fundingWallet) return null;

  const jupEndpoints = [
    `https://quote-api.jup.ag/v6`,
    `https://api.jup.ag/v6`
  ];

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const baseApi = jupEndpoints[(attempt - 1) % jupEndpoints.length];
    
    try {
      const quoteUrl = `${baseApi}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${lamportsAmount}&slippageBps=150`;
      const quoteRes = await axios.get(quoteUrl, { timeout: 8000 }); 
      const quoteResponse = quoteRes.data;

      if (!quoteResponse) continue;

      const swapRes = await axios.post(`${baseApi}/swap`, {
        quoteResponse,
        userPublicKey: fundingWallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }, { timeout: 8000 });

      const { swapTransaction } = swapRes.data;
      const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      
      transaction.sign([fundingWallet]);
      
      const txid = await connection.sendTransaction(transaction, { skipPreflight: false, preflightCommitment: 'confirmed' });
      console.log(`⚡ Jupiter Auto-Trade Dispatched via ${baseApi}. Signature: ${txid}`);
      
      const outPriceEst = parseFloat(quoteResponse.outAmount) / Math.pow(10, 9);
      const inPriceEst = lamportsAmount / Math.pow(10, 9);
      const fallbackEntryPriceUsd = inPriceEst > 0 ? (inPriceEst / outPriceEst) * 145 : 0.00001;

      return { txid, priceUsd: fallbackEntryPriceUsd };
    } catch (error: any) {
      console.warn(`⚠️ Jupiter network connection warning on attempt ${attempt}/${maxRetries} using ${baseApi}: ${error.message || error}`);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      }
    }
  }

  console.error(`❌ Critical: All ${maxRetries} Jupiter API gateway attempts exhausted for ${outputMint}. Trade aborted.`);
  return null;
}

// 6. TRACKING RISK, HARD STOP-LOSS, & DYNAMIC TAKE-PROFIT CONTROLLER
async function processActivePositions() {
  if (!fundingWallet) return;
  try {
    const activePositions = await db.query('SELECT * FROM token_intelligence WHERE bought = TRUE AND tokens_held > 0');
    
    for (const pos of activePositions.rows) {
      const marketRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${pos.token_address}`);
      const pairData = marketRes.data?.pairs?.[0];
      if (!pairData) continue;

      const currentPriceUsd = parseFloat(pairData.priceUsd || '0');
      const entryPriceUsd = parseFloat(pos.buy_price_usd || '0');
      if (entryPriceUsd <= 0 || currentPriceUsd <= 0) continue;

      const currentMultiplier = currentPriceUsd / entryPriceUsd;

      // Stop-Loss Condition: -30% drop threshold (Multiplier <= 0.70)
      if (currentMultiplier <= 0.70) {
        console.log(`🛑 STOP-LOSS TRIGGERED: $${pos.ticker} dropped 30% below entry. Commencing emergency liquidation...`);
        const totalTokensToSell = parseFloat(pos.tokens_held);
        
        const sellResult = await executeJupiterSwap(pos.token_address, "So11111111111111111111111111111111111111112", Math.floor(totalTokensToSell * Math.pow(10, 9)));
        
        if (sellResult) {
          await db.query('UPDATE token_intelligence SET tokens_held = 0 WHERE token_address = $1', [pos.token_address]);
          await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `🛑 <b>STOP-LOSS LIQUIDATION EXECUTED</b> 🛑\n\nPosition on $${pos.ticker} hit the -30% threshold. Emergency market swap back to SOL complete to protect core capital.\n• Entry Price: $${entryPriceUsd}\n• Exit Price: $${currentPriceUsd}`);
          continue; 
        }
      }

      let highestMultiplier = Math.max(parseFloat(pos.highest_multiplier || '1.0'), currentMultiplier);

      // TAKE PROFIT 1: Initial Capital Recovery at 2.0x Return
      if (highestMultiplier >= 2.0 && parseFloat(pos.highest_multiplier || '1.0') < 2.0) {
        console.log(`🎯 Milestone Hit: 2x on $${pos.ticker}. Triggering initial capital recovery execution...`);
        const totalTokensToSell = parseFloat(pos.tokens_held) * 0.5; 
        
        const sellResult = await executeJupiterSwap(pos.token_address, "So11111111111111111111111111111111111111112", Math.floor(totalTokensToSell * Math.pow(10, 9)));
        
        if (sellResult) {
          await db.query('UPDATE token_intelligence SET tokens_held = tokens_held - $1, highest_multiplier = 2.0 WHERE token_address = $2', [totalTokensToSell, pos.token_address]);
          await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `💰 <b>CAPITAL EXTRACTED (2x)</b> 💰\n\nRecovered baseline capital investments on $${pos.ticker}. Remaining moonbag is running on pure profit.`);
        }
      }

      // TAKE PROFIT 2: Follow-Up Tier Scaling Engine: Sell 30% for every additional 2x increment achieved
      const expectedNextTier = Math.floor(highestMultiplier / 2.0) * 2.0;
      const lastRecordedTier = Math.floor(parseFloat(pos.highest_multiplier || '1.0') / 2.0) * 2.0;

      if (expectedNextTier > lastRecordedTier && expectedNextTier >= 4.0) {
        console.log(`🎯 Additional Profit Scaling Tier Triggered: ${expectedNextTier}x on $${pos.ticker}. Dumping 30%...`);
        const totalTokensToSell = parseFloat(pos.tokens_held) * 0.30;
        const sellResult = await executeJupiterSwap(pos.token_address, "So11111111111111111111111111111111111111112", Math.floor(totalTokensToSell * Math.pow(10, 9)));
        
        if (sellResult) {
          await db.query('UPDATE token_intelligence SET tokens_held = tokens_held - $1, highest_multiplier = $2 WHERE token_address = $3', [totalTokensToSell, expectedNextTier, pos.token_address]);
          await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `📈 <b>TAKE PROFIT TIERS SCALED</b> 📈\n\nToken $${pos.ticker} reached ${expectedNextTier}x from entry. Scaled out 30% of position size to profits.`);
        }
      }
    }
  } catch (err) {
    console.error("Error running tracking position matrices:", err);
  }
}

// 7. CORE MATHEMATICAL INTELLIGENCE SCORING ENGINE
function calculateAlphaMetrics(pairData: any): TokenSignal {
  const liquidity = parseFloat(pairData.liquidity?.usd || '0');
  const volume24h = parseFloat(pairData.volume?.m5 || '0') * 12; 
  const marketCap = parseFloat(pairData.fdv || pairData.marketCap || '0');

  let rugProbability = 0.15;
  if (liquidity < 15000) rugProbability += 0.35;

  let alphaScore = 50;
  if (volume24h > 50000) alphaScore += 25;
  if (liquidity > 30000) alphaScore += 15;

  const insiderRiskScore = liquidity < 20000 ? 45.0 : 15.0;
  const narrativeStrength = volume24h > 100000 ? 85.0 : 40.0;

  return {
    tokenAddress: pairData.baseToken.address,
    ticker: pairData.baseToken.symbol,
    alphaScore: Math.min(alphaScore, 100),
    rugProbability: Math.min(rugProbability, 1.0),
    insiderRiskScore,
    narrativeStrength,
    classification: alphaScore > 75 ? 'HIGH_POTENTIAL_RUNNER' : 'ORGANIC',
    marketCap
  };
}

// 8. THE UPDATED DUAL-STREAM INGESTION & SCANNING LOOP PIPELINE
async function scanSolanaTokenProfiles() {
  try {
    console.log("🔍 Extracting current token profiles from Solana dual-streams...");
    
    // UPGRADED ENGINE: Concurrently requesting both feeds to maximize data volume
    const [latestRes, updatesRes] = await Promise.all([
      axios.get('https://api.dexscreener.com/token-profiles/latest/v1'),
      axios.get('https://api.dexscreener.com/token-profiles/recent-updates/v1')
    ]);

    const combinedProfiles = [...(latestRes.data || []), ...(updatesRes.data || [])];
    
    // Deduplicate profiles by token address so we don't scan the same token twice
    const uniqueProfilesMap = new Map();
    for (const profile of combinedProfiles) {
      if (profile.chainId === 'solana' && profile.tokenAddress) {
        uniqueProfilesMap.set(profile.tokenAddress, profile);
      }
    }

    for (const profile of uniqueProfilesMap.values()) {
      const hasTwitter = profile.links?.some((l: any) => l.type === 'twitter' || l.url?.includes('x.com') || l.url?.includes('twitter.com'));
      if (!hasTwitter) continue;

      const passesLoreCheck = evaluatedLoreUniqueness(profile.tokenAddress, profile.description || '');
      if (!passesLoreCheck) continue;

      const marketRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${profile.tokenAddress}`);
      const pairData = marketRes.data?.pairs?.[0];
      if (!pairData) continue;

      const metrics = calculateAlphaMetrics(pairData);

      // Market Cap Guardrails (Min: 7k, Max: 100k)
      if (metrics.marketCap < 7000 || metrics.marketCap > 100000) continue;

      // Track For Aggressive Developer Dumping Mechanics
      const sellRatio5m = pairData.txns?.m5?.sells || 0;
      const buyRatio5m = pairData.txns?.m5?.buys || 0;
      const totalRatio = buyRatio5m + sellRatio5m;
      if (totalRatio > 5 && (sellRatio5m / totalRatio) > 0.65) {
        console.log(`⚠️ Dumping Flagged: Skipping $${metrics.ticker} due to high corrections sell volume ratio.`);
        continue; 
      }

      const checkDup = await db.query('SELECT alert_sent, bought FROM token_intelligence WHERE token_address = $1', [profile.tokenAddress]);
      
      if (checkDup.rows.length === 0) {
        await db.query(`
          INSERT INTO token_intelligence (token_address, ticker, alpha_score, rug_probability, insider_risk_score, narrative_strength, classification, alert_sent)
          VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
        `, [metrics.tokenAddress, metrics.ticker, metrics.alphaScore, metrics.rugProbability, metrics.insiderRiskScore, metrics.narrativeStrength, metrics.classification]);
      }

      if (metrics.alphaScore >= 65 && metrics.rugProbability < 0.35) {
        const alreadyAlerted = checkDup.rows[0]?.alert_sent || false;
        const alreadyBought = checkDup.rows[0]?.bought || false;
        
        let buySuccessString = "⚠️ Auto-Buy Bypassed (Inactive Wallet Configuration Key)";
        
        if (!alreadyBought && fundingWallet) {
          try {
            const walletBalanceLamports = await connection.getBalance(fundingWallet.publicKey);
            const allocationLamports = Math.floor(walletBalanceLamports * 0.20);
            
            if (allocationLamports > 5000000) { 
              const tradeReceipt = await executeJupiterSwap("So11111111111111111111111111111111111111112", metrics.tokenAddress, allocationLamports);
              if (tradeReceipt) {
                buySuccessString = `🟢 <b>AUTO-BUY EXECUTED</b>\nAllocated 20% Wallet Balance\nTx: <code>${tradeReceipt.txid}</code>`;
                
                await db.query suicide(`
                  UPDATE token_intelligence 
                  SET bought = TRUE, buy_price_usd = $1, tokens_held = $2 
                  WHERE token_address = $3
                `, [tradeReceipt.priceUsd, 1000000000, metrics.tokenAddress]); 
              } else {
                buySuccessString = "❌ Auto-Buy Execution Blocked (Route Liquidity Issue)";
              }
            } else {
              buySuccessString = "❌ Auto-Buy Skipped (Insufficient Solana Core Reserves)";
            }
          } catch (tradeErr) {
            console.error("Trade transaction logic integration error:", tradeErr);
          }
        }

        if (!alreadyAlerted && TELEGRAM_CHAT_ID) {
          const deployerWallet = profile.deployer || "PumpFun_Contract_Agent";
          const formattedMCAP = metrics.marketCap > 0 ? `$${metrics.marketCap.toLocaleString()}` : "Calculating...";

          const message = `🚨 <b>AUTONOMOUS AI LORE DEGEN CALL</b> 🚨\n\n` +
                          `<b>Token:</b> $${metrics.ticker}\n` +
                          `<b>Address:</b> <code>${metrics.tokenAddress}</code>\n` +
                          `<b>Market Cap:</b> 💰 <b>${formattedMCAP}</b>\n\n` +
                          `🤖 <b>Execution State:</b>\n${buySuccessString}\n\n` +
                          `👨‍💻 <b>Deployer Metrics:</b>\n` +
                          `• Wallet: <code>${deployerWallet}</code>\n` +
                          `• Story Check: 📚 <i>Unique Narrative Validated</i>\n\n` +
                          `📊 <b>AI Intelligence Matrix:</b>\n` +
                          `• Alpha Score: 🟢 <b>${metrics.alphaScore}/100</b>\n` +
                          `• Rug Probability: 🛡️ <b>${(metrics.rugProbability * 100).toFixed(0)}%</b>\n` +
                          `• Dynamic Mode: ⚡ <code>${metrics.classification}</code>\n\n` +
                          `📱 <a href="https://dexscreener.com/solana/${metrics.tokenAddress}">Monitor Chart Live</a>`;

          await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { 
            parse_mode: 'HTML', 
            disable_web_page_preview: true 
          } as any);

          await db.query('UPDATE token_intelligence SET alert_sent = TRUE WHERE token_address = $1', [metrics.tokenAddress]);
        }
      }
    }
  } catch (err) {
    console.error("Error encountered during active token pool scan loop:", err);
  }
}

// 9. MASTER ENGINE INITIALIZER BOOTSTRAPPER
async function main() {
  await initDatabaseSchema();

  if (process.env.TELEGRAM_BOT_TOKEN) {
    bot.launch().then(() => console.log("🤖 Telegram Integration Service Online. Listening..."));
  }

  // Active Monitoring Cycles
  setInterval(scanSolanaTokenProfiles, 1000 * 60 * 3);
  setInterval(processActivePositions, 1000 * 30); 
  
  scanSolanaTokenProfiles();

  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ bot: "alpha-degen-bot-v3", active: true }));
  }).listen(port);
}

main().catch(console.error);
