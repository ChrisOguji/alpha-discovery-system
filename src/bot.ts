import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';
import WebSocket from 'ws';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { OnChainPatternRecognition } from './intelligence';
import { CapitalRiskEngine } from './risk';
import { LowLatencyExecutionEngine } from './execution';
import { TokenSignal } from './types';
import { saveEncryptedWallet, loadDecryptedWallet } from './wallet';
import { saveSetting, loadSettings, BotSettings, DEFAULT_SETTINGS } from './settings';
import Redis from 'ioredis';
import { db, initDatabaseSchema } from './db';

const redis = new Redis(process.env.REDIS_URL || '');

dotenv.config();

const PORT = Number(process.env.PORT) || 10000;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
// ── Security: only respond in authorized chat ──
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id?.toString();
  if (chatId !== CHAT_ID) {
    console.log(`🚫 Unauthorized access attempt from chat: ${chatId}`);
    return; // silently ignore — don't respond at all
  }
  return next();
});
const intelligence = new OnChainPatternRecognition();
const riskEngine = new CapitalRiskEngine();
const executor = new LowLatencyExecutionEngine();

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const DOMAIN = process.env.RAILWAY_STATIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://alpha-discovery-system.onrender.com';
const seenTokens = new Set<string>();
const wssPumpTokensQueue: any[] = [];
type AwaitingType = 'privateKey' | 'tradeSize' | 'tp' | 'sl';
const awaitingInput = new Map<string, AwaitingType>();
let botSettings: BotSettings = { ...DEFAULT_SETTINGS };

interface Position {
  ticker: string;
  address: string;
  entryPrice: number;
  peakPrice: number;
  sizeSol: number;
  entryTime: number;
  // ── Dynamic trailing stop loss state ──
  stopLossLevel: 'initial' | 'breakeven' | 'trailing';
  stopLossPct: number; // current stop loss % relative to entry (negative = below entry)
  remainingPct: number; // remaining position size (starts at 100)
}
const openPositions = new Map<string, Position>();

interface AlertRecord {
  ticker: string;
  address: string;
  alertTime: number;
  alertMcap: number;
  alertPrice: number;
  peakMcap: number;
  peakPrice: number;
  peakTime: number;
  currentMcap: number;
  currentPrice: number;
  lastUpdated: number;
  exitReason?: 'TP' | 'SL' | 'OPEN';
  exitPrice?: number;
  exitMcap?: number;
  exitTime?: number;
}
let alertHistory = new Map<string, AlertRecord>();

// ✅ Load history from Redis first, then Supabase as fallback
async function loadHistory() {
  try {
    const data = await redis.get('bot_history');
    if (data) {
      alertHistory = new Map(JSON.parse(data));
      console.log(`✅ History loaded from Redis: ${alertHistory.size} records`);
      return;
    }
  } catch (e) {
    console.log('⚠️ Redis load failed, trying Supabase...');
  }

  // ✅ Supabase fallback
  try {
    const result = await db.query(`
      SELECT address, ticker, alert_time, alert_mcap, alert_price,
             peak_mcap, peak_price, peak_time, current_mcap, current_price, last_updated
      FROM alert_history ORDER BY alert_time DESC LIMIT 500
    `);
    for (const row of result.rows) {
      alertHistory.set(row.address, {
        ticker: row.ticker,
        address: row.address,
        alertTime: Number(row.alert_time),
        alertMcap: Number(row.alert_mcap),
        alertPrice: Number(row.alert_price),
        peakMcap: Number(row.peak_mcap),
        peakPrice: Number(row.peak_price),
        peakTime: Number(row.peak_time),
        currentMcap: Number(row.current_mcap),
        currentPrice: Number(row.current_price),
        lastUpdated: Number(row.last_updated)
      });
    }
    console.log(`✅ History loaded from Supabase: ${alertHistory.size} records`);
  } catch (e: any) {
    console.log(`⚠️ Supabase load failed: ${e.message}`);
  }
}

// ✅ Save to both Redis and Supabase
async function saveHistory() {
  // Redis save
  try {
    await redis.set('bot_history', JSON.stringify(Array.from(alertHistory.entries())));
  } catch (e: any) {
    console.log(`⚠️ Redis save failed: ${e.message}`);
  }

  // Supabase save — upsert so peaks update but alertTime never changes
  try {
    for (const rec of alertHistory.values()) {
      await db.query(`
        INSERT INTO alert_history (
          address, ticker, alert_time, alert_mcap, alert_price,
          peak_mcap, peak_price, peak_time, current_mcap, current_price, last_updated
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (address) DO UPDATE SET
          peak_mcap = GREATEST(alert_history.peak_mcap, EXCLUDED.peak_mcap),
          peak_price = GREATEST(alert_history.peak_price, EXCLUDED.peak_price),
          peak_time = CASE WHEN EXCLUDED.peak_price > alert_history.peak_price
                     THEN EXCLUDED.peak_time ELSE alert_history.peak_time END,
          current_mcap = EXCLUDED.current_mcap,
          current_price = EXCLUDED.current_price,
          last_updated = EXCLUDED.last_updated
      `, [
        rec.address, rec.ticker, rec.alertTime, rec.alertMcap, rec.alertPrice,
        rec.peakMcap, rec.peakPrice, rec.peakTime, rec.currentMcap, rec.currentPrice, rec.lastUpdated
      ]);
    }
  } catch (e: any) {
    console.log(`⚠️ Supabase save failed: ${e.message}`);
  }
}

function escapeText(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function getDynamicMode(score: number): string {
  if (score >= 90) return '⚡ HIGH\\_POTENTIAL\\_RUNNER';
  if (score >= 80) return '⚡ STRONG\\_SIGNAL';
  return '⚡ ORGANIC';
}

// AFTER
function computeAlphaScore(mcap: number, liquidity: number, rugProb: number): number {
  let score = 0;
  const ratio = liquidity / mcap;
  if (ratio >= 0.30) score += 40;
  else if (ratio >= 0.20) score += 30;
  else if (ratio >= 0.10) score += 20;
  else if (ratio >= 0.05) score += 10;
  if (mcap >= 1000 && mcap <= 40000) score += 25;

  // ── Liquidity scoring: ratio bonus for $10k–$17k range, raw otherwise ──
  if (mcap >= 10000 && mcap <= 17000) {
    if (ratio >= 0.30) score += 20;
    else if (ratio >= 0.20) score += 14;
    else if (ratio >= 0.10) score += 7;
  } else {
    if (liquidity >= 25000) score += 20;
    else if (liquidity >= 10000) score += 12;
    else if (liquidity >= 5000) score += 6;
  }

  if (rugProb <= 0.10) score += 15;
  else if (rugProb <= 0.20) score += 8;
  else if (rugProb >= 0.30) score -= 10;
  return Math.min(100, Math.max(0, score));
}

function computeRugProbability(mcap: number, liquidity: number): number {
  const ratio = liquidity / mcap;
  if (ratio < 0.05) return 0.65;
  if (ratio < 0.10) return 0.40;
  if (ratio < 0.20) return 0.25;
  if (mcap < 5000) return 0.35;
  return 0.12;
}

function isReversalCandidate(pair: any): boolean {
  const h24 = parseFloat(pair.priceChange?.h24 || '0');
  const h6 = parseFloat(pair.priceChange?.h6 || '0');
  const h1 = parseFloat(pair.priceChange?.h1 || '0');
  const volH24 = parseFloat(pair.volume?.h24 || '0');
  const volH6 = parseFloat(pair.volume?.h6 || '0');
  // AFTER
const recoveringH1 = h1 > 0;
const stillDownH6 = h6 < 0;
const volumeReturning = volH6 > 0 && volH24 > 0 && (volH6 / volH24) > 0.3;
const dumpedHard = h24 <= -40;
return dumpedHard && recoveringH1 && stillDownH6 && volumeReturning;
}

function startPumpPortalStream() {
  console.log("🔗 Connecting to PumpPortal WSS...");
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.on('open', () => {
    console.log("🟢 WSS Connected!");
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });
  ws.on('message', (data: any) => {
    try {
      const token = JSON.parse(data.toString());
      if (token.mint && token.symbol) {
        wssPumpTokensQueue.push({
          tokenAddress: token.mint,
          source: 'pumpfun-new',
          cachedMcap: token.vSolInBondingCurve || 26000,
          cachedName: token.symbol,
          createdAt: Date.now()
        });
      }
    } catch (e) {}
  });
  ws.on('close', () => {
    console.log("🔴 WSS Disconnected. Reconnecting...");
    setTimeout(startPumpPortalStream, 5000);
  });
  ws.on('error', (err: any) => console.error("⚠️ WSS Error:", err.message));
}

async function getLivePrice(address: string): Promise<{ price: number; mcap: number }> {
  try {
    const jupRes = await axios.get(`https://api.jup.ag/price/v2?ids=${address}`, { timeout: 4000 });
    const jupPrice = parseFloat(jupRes.data?.data?.[address]?.price || '0');
    if (jupPrice > 0) {
      try {
        const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${address}`, {
          timeout: 3000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' }
        });
        return { price: jupPrice, mcap: parseFloat(pumpRes.data?.usd_market_cap || '0') };
      } catch {
        return { price: jupPrice, mcap: 0 };
      }
    }
  } catch {}

  try {
    const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${address}`, {
      timeout: 4000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' }
    });
    const price = parseFloat(pumpRes.data?.price || pumpRes.data?.sol_price || '0');
    const mcap = parseFloat(pumpRes.data?.usd_market_cap || '0');
    if (price > 0) return { price, mcap };
  } catch {}

  try {
    const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 5000 });
    const pair = dexRes.data?.pairs?.[0];
    const price = parseFloat(pair?.priceUsd || '0');
    const mcap = parseFloat(pair?.fdv || pair?.marketCap || '0');
    if (price > 0) return { price, mcap };
  } catch {}

  return { price: 0, mcap: 0 };
}

async function monitorPositions() {
  const now = Date.now();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  const recentAlerts = [...alertHistory.keys()].filter(addr => {
    const rec = alertHistory.get(addr);
    return rec && (now - rec.alertTime) < TWENTY_FOUR_HOURS;
  });

  const allAddresses = new Set([...openPositions.keys(), ...recentAlerts]);
  if (allAddresses.size === 0) return;

  await Promise.all(Array.from(allAddresses).map(async (address) => {
    try {
      const { price: currentPrice, mcap: currentMcap } = await getLivePrice(address);
      if (!currentPrice) return;

      if (alertHistory.has(address)) {
        const rec = alertHistory.get(address)!;
        const updated: AlertRecord = { ...rec, currentPrice, currentMcap, lastUpdated: now };
        if (currentPrice > rec.peakPrice) {
          updated.peakPrice = currentPrice;
          updated.peakMcap = currentMcap;
          updated.peakTime = now;
          console.log(`📈 New peak ${rec.ticker}: $${currentPrice.toFixed(8)} (+${(((currentPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(1)}%)`);
        }
        alertHistory.set(address, updated);
      }

      if (openPositions.has(address)) {
        const pos = openPositions.get(address)!;
        const updated = { ...pos };
        if (currentPrice > pos.peakPrice) updated.peakPrice = currentPrice;

        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const holdingMins = Math.floor((now - pos.entryTime) / 60000);

        const tp = botSettings.takeProfitPct;
        const sl = botSettings.stopLossPct;

        // ── TAKE PROFIT ──
        if (pnlPct >= tp) {
          const pnlSol = pos.sizeSol * (pnlPct / 100);
          const msg = [
            `🎯 *TAKE PROFIT — +${tp}% HIT*`, ``,
            `*Token:* $${escapeText(pos.ticker)}`,
            `*Entry:* $${pos.entryPrice.toFixed(8)}`,
            `*Exit:* $${currentPrice.toFixed(8)}`,
            `*PnL:* 🟢 +${pnlPct.toFixed(2)}%`,
            `*Profit:* +${pnlSol.toFixed(4)} SOL`,
            `*Held:* ${holdingMins} minutes`,
          ].join('\n');
          await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
          openPositions.delete(address);
          console.log(`✅ TP hit: ${pos.ticker} +${pnlPct.toFixed(1)}%`);
          if (alertHistory.has(address)) {
            const rec = alertHistory.get(address)!;
            alertHistory.set(address, {
              ...rec,
              exitReason: 'TP',
              exitPrice: currentPrice,
              exitMcap: currentMcap,
              exitTime: Date.now()
            });
            await saveHistory();
          }
          return;
        }

        // ── STOP LOSS ──
        if (pnlPct <= -sl) {
          const pnlSol = pos.sizeSol * (pnlPct / 100);
          const msg = [
            `🛑 *STOP LOSS — -${sl}% HIT*`, ``,
            `*Token:* $${escapeText(pos.ticker)}`,
            `*Address:* \`${address}\``, ``,
            `*Entry Price:* $${pos.entryPrice.toFixed(8)}`,
            `*Exit Price:* $${currentPrice.toFixed(8)}`,
            `*PnL:* 🔴 ${pnlPct.toFixed(2)}%`,
            `*Loss:* ${pnlSol.toFixed(4)} SOL`,
            `*Size:* ${pos.sizeSol} SOL`,
            `*Held:* ${holdingMins} minutes`,
          ].join('\n');
          await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
          openPositions.delete(address);
          console.log(`✅ SL hit: ${pos.ticker} ${pnlPct.toFixed(1)}%`);
          if (alertHistory.has(address)) {
            const rec = alertHistory.get(address)!;
            alertHistory.set(address, {
              ...rec,
              exitReason: 'SL',
              exitPrice: currentPrice,
              exitMcap: currentMcap,
              exitTime: Date.now()
            });
            await saveHistory();
          }
          return;
        }

        openPositions.set(address, updated);
      }
    } catch (err: any) {
      console.log(`❌ Monitor error ${address}: ${err.message}`);
    }
  }));

  await saveHistory();
}

async function scan() {
  console.log("🔍 Scanning pump.fun + PumpSwap + Early Detection + Reversals...");
  try {

    const profilesRes = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 });
    const profiles = profilesRes.data || [];
    const pumpProfiles = profiles
      .filter((p: any) => typeof p.tokenAddress === 'string' && p.tokenAddress.endsWith('pump'))
      .map((p: any) => ({ tokenAddress: p.tokenAddress, source: 'profiles' }));

    let pumpSwapProfiles: any[] = [];
    try {
      const pumpSwapRes = await axios.get('https://api.dexscreener.com/latest/dex/pairs/solana/pumpfun', { timeout: 10000 });
      pumpSwapProfiles = (pumpSwapRes.data?.pairs || [])
        .filter((p: any) => p.baseToken?.address && p.chainId === 'solana')
        .map((p: any) => ({ tokenAddress: p.baseToken.address, source: 'pumpswap', cachedPair: p }));
      console.log(`PumpSwap: ${pumpSwapProfiles.length} pairs`);
    } catch (psErr: any) { console.log(`⚠️ PumpSwap failed: ${psErr.message}`); }

    let newPumpTokens: any[] = [];
    try {
      newPumpTokens = [...wssPumpTokensQueue];
      wssPumpTokensQueue.length = 0;
      console.log(`Pump.fun new (via WSS): ${newPumpTokens.length} tokens`);
    } catch (nErr: any) { console.log(`⚠️ WSS queue error: ${nErr.message}`); }

    let newDexPairs: any[] = [];
    try {
      const newPairsRes = await axios.get('https://api.dexscreener.com/latest/dex/search?q=pump.fun&chainIds=solana', { timeout: 10000 });
      newDexPairs = (newPairsRes.data?.pairs || [])
        .filter((p: any) =>
          p.baseToken?.address?.endsWith('pump') &&
          p.chainId === 'solana' &&
          p.pairCreatedAt && (Date.now() - p.pairCreatedAt) < 2 * 60 * 60 * 1000
        )
        .map((p: any) => ({ tokenAddress: p.baseToken.address, source: 'dex-new', cachedPair: p }));
      console.log(`New DEX pairs: ${newDexPairs.length}`);
    } catch (dErr: any) { console.log(`⚠️ New DEX pairs failed: ${dErr.message}`); }

    let reversalTokens: any[] = [];
    try {
      const reversalRes = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana&chainIds=solana', { timeout: 10000 });
      reversalTokens = (reversalRes.data?.pairs || [])
        .filter((p: any) =>
          p.baseToken?.address?.endsWith('pump') &&
          p.chainId === 'solana' &&
          isReversalCandidate(p) &&
          parseFloat(p.fdv || p.marketCap || '0') >= 5000 &&
          parseFloat(p.fdv || p.marketCap || '0') <= 50000
        )
        .map((p: any) => ({ tokenAddress: p.baseToken.address, source: 'reversal', cachedPair: p }));
      console.log(`Reversals: ${reversalTokens.length}`);
    } catch (rErr: any) { console.log(`⚠️ Reversal scan failed: ${rErr.message}`); }

    // ── FIX 2: Prioritize WSS new tokens first before slicing to 40 ──
    const prioritized = [
      ...newPumpTokens,
      ...newDexPairs,
      ...reversalTokens,
      ...pumpSwapProfiles,
      ...pumpProfiles
    ].filter((p, i, arr) => arr.findIndex(x => x.tokenAddress === p.tokenAddress) === i);

    console.log(`Total candidates: ${prioritized.length} across 5 sources`);

    for (const p of prioritized.slice(0, 40)) {
      try {
        await new Promise(resolve => setTimeout(resolve, 800));
        if (seenTokens.has(p.tokenAddress)) continue;

        let pair = p.cachedPair || null;
        if (!pair) {
          try {
            const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`, { timeout: 8000 });
            pair = data?.pairs?.[0];
          } catch {
            seenTokens.add(p.tokenAddress);
            continue;
          }
        }

        let mcap = pair ? parseFloat(pair.fdv || pair.marketCap || '0') : (p.cachedMcap || 0);
        let liquidity = pair ? parseFloat(pair.liquidity?.usd || '0') : 0;
        const ticker = pair?.baseToken?.symbol || p.cachedName || 'UNKNOWN';
        const address = pair?.baseToken?.address || p.tokenAddress;
        const creatorAddress = pair?.info?.deployer || undefined;
        const currentPrice = parseFloat(pair?.priceUsd || '0');

        if (!liquidity && mcap > 0) liquidity = mcap * 0.15;
        if (!mcap) { seenTokens.add(p.tokenAddress); continue; }

        const isNew = p.source === 'pumpfun-new' || p.source === 'dex-new';
        const isReversal = p.source === 'reversal';
        const mcapMin = isNew ? 5000 : 5000;

        // ── FIX 1: Soft skips do NOT add to seenTokens — token stays eligible for re-scan ──
        if (mcap < mcapMin || mcap > 50000) continue;

        // ── Number 4: Time-alive filter — skip tokens under 7 minutes old (non-WSS only) ──
        if (!isNew && pair?.pairCreatedAt) {
          const ageMinutes = (Date.now() - pair.pairCreatedAt) / 60000;
          if (ageMinutes < 40) {
            console.log(`⏭ ${ticker} too young: ${ageMinutes.toFixed(1)} mins old, skipping`);
            // ── FIX 1: Soft skip — do NOT add to seenTokens ──
            continue;
          }
        }

        const rugProb = computeRugProbability(mcap, liquidity);
        const alphaScore = computeAlphaScore(mcap, liquidity, rugProb);
        const scoreMin = isNew ? 70 : 75;

        console.log(`[${p.source}] ${ticker}: MCAP $${mcap} | Liq $${liquidity} | Score ${alphaScore}/100`);

        // ── FIX 1: Low score is a soft skip — do NOT add to seenTokens ──
        if (alphaScore < scoreMin) continue;

        const signal: TokenSignal = {
          tokenAddress: address, ticker, alphaScore,
          rugProbability: rugProb, liquidityUsd: liquidity, marketCapUsd: mcap,
        };

        const [pattern, risk] = await Promise.all([
          // ── FIX 3: Pass isNew to analyzePattern so new tokens skip LOW_BUYER_VELOCITY gate ──
          intelligence.analyzePattern(signal, creatorAddress, isNew),
          riskEngine.validateExecutionRisk(signal),
        ]);

        if (!pattern.passedPatterns) {
          console.log(`⏭ ${ticker} failed: ${pattern.reason}`);
          seenTokens.add(p.tokenAddress);
          continue;
        }

        const h24 = pair ? parseFloat(pair.priceChange?.h24 || '0') : 0;
        const h1 = pair ? parseFloat(pair.priceChange?.h1 || '0') : 0;

        let executionState = '';
        let executedSizeSol = 0;
        let executedPrice = 0;

        if (!executor.hasWallet()) {
          executionState = `⚙️ No wallet — use /settings to enable auto\\-buy`;
        } else if (risk.allow) {
          try {
            const tradeSol = botSettings.tradeSizeSol;
            const tx = await executor.buildJupiterSwapTransaction(address, tradeSol, 'BUY');
            tx.sign([executor.getWalletKeypair()]);
            const result = await executor.dispatchMevProtectedBundle(tx);
            if (result.success) {
              const txLink = result.bundleId ? ` — [Solscan](https://solscan.io/tx/${result.bundleId})` : '';
              executionState = `✅ Auto\\-Buy Executed${txLink}`;
              executedSizeSol = tradeSol;
              executedPrice = currentPrice;
              if (executedPrice > 0) {
                openPositions.set(address, {
                  ticker, address,
                  entryPrice: executedPrice,
                  peakPrice: executedPrice,
                  sizeSol: executedSizeSol,
                  entryTime: Date.now(),
                  stopLossLevel: 'initial',
                  stopLossPct: -35,
                  remainingPct: 100,
                });
                console.log(`📌 Position opened: ${ticker} @ $${executedPrice}`);
              }
            } else {
              executionState = `❌ Auto\\-Buy Failed: ${escapeText(result.error || '')}`;
            }
          } catch (execErr: any) {
            console.log("🔥 AUTO-BUY REJECTION REASON:", JSON.stringify(execErr.response?.data || execErr.message));
            const isNetworkErr = execErr.message?.includes('ENOTFOUND') || execErr.message?.includes('ECONNREFUSED');
            executionState = isNetworkErr
              ? `⏸ Execution Paused: Jupiter unreachable on free tier`
              : `❌ Execution Blocked: ${escapeText(execErr.message)}`;
          }
        } else {
          executionState = `❌ Auto\\-Buy Blocked: ${escapeText(risk.reason || '')}`;
        }

        // ✅ Only set alert record if NOT already tracked — preserve original alertTime
        if (!alertHistory.has(address)) {
          alertHistory.set(address, {
            ticker, address,
            alertTime: Date.now(),
            alertMcap: mcap,
            alertPrice: currentPrice,
            peakMcap: mcap,
            peakPrice: currentPrice,
            peakTime: Date.now(),
            currentMcap: mcap,
            currentPrice,
            lastUpdated: Date.now()
          });
          await saveHistory();
        }

        const walletShort = executor.hasWallet()
          ? `${executor.getWalletPublicKey().slice(0, 8)}...${executor.getWalletPublicKey().slice(-4)}`
          : 'Not set — use /settings';
        const sourceLabel: Record<string, string> = {
          'pumpfun-new': '🆕 Pump\\.fun \\(Just Launched\\)',
          'dex-new': '⚡ New DEX Pair',
          'pumpswap': '🔄 PumpSwap',
          'profiles': '📈 Trending',
          'reversal': '🔄 Reversal \\(Retraced & Building\\)'
        };

        const reversalLine = isReversal
          ? [``, `📉 *Reversal Signal:* 24h: ${h24.toFixed(1)}% | 1h: +${h1.toFixed(1)}% recovering`]
          : [];

        const msg = [
          `🚨🚨 *AUTONOMOUS AI DEGEN CALL* 🚨🚨`, ``,
          `*Token:* $${escapeText(ticker)}`,
          `*Address:* \`${address}\``,
          `*Market Cap:* 💰 $${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `*Liquidity:* $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `*Source:* ${sourceLabel[p.source] || '📈 Trending'}`,
          ...reversalLine, ``,
          `🤖 *Execution State:*`,
          executionState, ``,
          `👾 *Deployer Metrics:*`,
          `• Wallet: \`${walletShort}\``,
          `• Bundled Launch: ${pattern.isBundledLaunch ? '⚠️ Yes' : '✅ No'}`,
          `• Top Holder %: ${pattern.topHolderConcentration}%`,
          `• Liquidity Locked: ${pattern.isLiquidityLocked ? '✅ Yes' : '❌ No'}`,
          `• Wash Trading: ${pattern.washTradingDetected ? '⚠️ Detected' : '✅ Clean'}`,
          `• Unique Buyers: ${pattern.uniqueBuyers} \\(${pattern.buyerVelocity} velocity\\)`,
          `• Smart Money: ${pattern.smartCohortPresence ? '✅ Present' : '➖ None'}`,
          `• Pump\\.fun: ${pattern.isPumpFun ? '✅ Verified' : '✅ Confirmed'}`, ``,
          `📊 *AI Intelligence Matrix:*`,
          `• Alpha Score: 🟢 ${alphaScore}/100 — ${alphaScore === 100 ? '🔥 PERFECT SCORE' : '✅ HIGH CONVICTION'}`,
          `• Rug Probability: 🛡 ${(rugProb * 100).toFixed(0)}%`,
          `• Dev Rug History: ${pattern.devRugHistoryCount} prior rugs`,
          `• Dynamic Mode: ${getDynamicMode(alphaScore)}`, ``,
          `📱 [Monitor Chart Live](https://dexscreener.com/solana/${address})`,
        ].join('\n');

        await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        console.log(`✅ Alert sent: ${ticker} — Score: ${alphaScore}/100 — Source: ${p.source}`);

        seenTokens.add(p.tokenAddress);
        if (seenTokens.size > 500) seenTokens.clear();

      } catch (innerErr: any) {
        console.log(`❌ Error on token: ${innerErr.message}`);
      }
    }
  } catch (e: any) {
    console.error("Global Scan Error:", e.message);
  }
}

// ✅ Initialize DB schema + load history before launching
async function init() {
  await initDatabaseSchema();

  // ✅ Create alert_history table if not exists
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS alert_history (
        address TEXT PRIMARY KEY,
        ticker TEXT,
        alert_time BIGINT,
        alert_mcap NUMERIC,
        alert_price NUMERIC,
        peak_mcap NUMERIC,
        peak_price NUMERIC,
        peak_time BIGINT,
        current_mcap NUMERIC,
        current_price NUMERIC,
        last_updated BIGINT
      );
    `);
    console.log('✅ alert_history table ready');
  } catch (e: any) {
    console.log(`⚠️ alert_history table setup failed: ${e.message}`);
  }

  // ✅ Load encrypted wallet + bot settings from DB
  if (CHAT_ID) {
    try {
      const storedKey = await loadDecryptedWallet(CHAT_ID);
      if (storedKey) {
        const keypair = Keypair.fromSecretKey(bs58.decode(storedKey));
        executor.setWallet(keypair);
        console.log(`✅ Wallet loaded from DB: ${keypair.publicKey.toBase58().slice(0, 8)}...`);
      }
    } catch (e: any) {
      console.log(`⚠️ Could not load wallet from DB: ${e.message}`);
    }

    try {
      botSettings = await loadSettings(CHAT_ID);
      console.log(`✅ Settings loaded — size: ${botSettings.tradeSizeSol} SOL | TP: ${botSettings.takeProfitPct}% | SL: ${botSettings.stopLossPct}%`);
    } catch (e: any) {
      console.log(`⚠️ Could not load settings from DB: ${e.message}`);
    }
  }

  await loadHistory();
}

bot.launch({
  webhook: { domain: DOMAIN, port: PORT }
}).then(async () => {
  console.log(`🤖 Bot Live via Webhook on port ${PORT}`);
  await init();
  startPumpPortalStream();
  scan();
  setInterval(scan, 60000);
  setInterval(monitorPositions, 30 * 1000);
  setInterval(async () => {
    try {
      await axios.get(DOMAIN, { timeout: 5000 });
      console.log('🏓 Self-ping sent — bot is alive');
    } catch {}
  }, 5 * 60 * 1000);

}).catch((err) => {
  console.error("Fatal Launch Error:", err);
  process.exit(1);
});

bot.command('test', (ctx) => ctx.reply('✅ Bot online. Scanning pump.fun (via WSS) + PumpSwap + Early Detection + Reversals.'));

bot.command('positions', async (ctx) => {
  if (openPositions.size === 0) return ctx.reply('📭 No open positions.');
  const lines = ['📊 *Open Positions:*', ''];
  for (const [address, pos] of openPositions.entries()) {
    const mins = Math.floor((Date.now() - pos.entryTime) / 60000);
    lines.push(`• $${escapeText(pos.ticker)} — ${pos.sizeSol} SOL — ${mins}m held`);
    lines.push(`  Entry: $${pos.entryPrice.toFixed(8)}`);
    lines.push(`  Peak: $${pos.peakPrice.toFixed(8)}`);
    lines.push(`  Stop Loss: -${botSettings.stopLossPct}% | Take Profit: +${botSettings.takeProfitPct}%`);
    lines.push('');
  }
  ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// ── Helper: build collective PnL token list for a period ──
function getPeriodDateString(period: string): string {
  const today = new Date();
  const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const todayStr = formatDate(today);

  let dateString = '';

  if (period === 'daily') {
    dateString = todayStr;
  } else if (period === 'weekly') {
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    dateString = `${formatDate(lastWeek)} - ${todayStr}`;
  } else if (period === 'monthly') {
    const lastMonth = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    dateString = `${formatDate(lastMonth)} - ${todayStr}`;
  } else if (period === 'lifetime') {
    let firstDate = new Date();
    if (alertHistory.size > 0) {
      // Memory-safe loop to find the oldest alert date without exceeding the call stack
      let earliest = Date.now();
      for (const r of alertHistory.values()) {
        if (r.alertTime < earliest) earliest = r.alertTime;
      }
      firstDate = new Date(earliest);
    }
    dateString = `${formatDate(firstDate)} - ${todayStr}`;
  }
  
  // Safely escape the generated string (specifically hyphens) for Telegram Markdown
  return escapeText(dateString);
}

async function buildPeriodPnlMessage(period: string): Promise<{ text: string; buttons: any[] }> {
  const now = Date.now();
  let cutoff: number;
if (period === 'daily') {
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  cutoff = todayUTC.getTime();
} else if (period === 'weekly') {
  cutoff = now - 7 * 24 * 60 * 60 * 1000;
} else if (period === 'monthly') {
  cutoff = now - 30 * 24 * 60 * 60 * 1000;
} else {
  cutoff = 0;
}
  const filtered = Array.from(alertHistory.entries())
    .filter(([, rec]) => rec.alertTime >= cutoff)
    .sort((a, b) => b[1].alertTime - a[1].alertTime)
    .slice(0, 20);

  const periodLabel: Record<string, string> = {
    daily: '📅 Daily', weekly: '📆 Weekly',
    monthly: '🗓 Monthly', lifetime: '🏆 Lifetime'
  };

  const buttons = filtered.map(([address, rec]) => {
    const pnlPct = rec.peakPrice > rec.alertPrice
      ? (((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(1)
      : '0';
    const label = `$${rec.ticker} | Peak: +${pnlPct}%`;
    return [Markup.button.callback(label, `pnl_${address}`)];
  });

  // Add refresh button at the bottom
  buttons.push([Markup.button.callback('🔄 Refresh', `period_${period}`)]);

  const dateInterval = getPeriodDateString(period);

  return {
    text: `📊 *${periodLabel[period]} Calls \\(${dateInterval}\\) \\(${filtered.length} tokens\\):*`,
    buttons
  };
}

// ✅ /pnl — period selector first, then token list
bot.command('pnl', async (ctx) => {
  if (alertHistory.size === 0) {
    return ctx.reply('📭 No alerts recorded yet.');
  }
  await ctx.reply(
    '📊 *Select a time period:*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📅 Daily', 'period_daily')],
        [Markup.button.callback('📆 Weekly', 'period_weekly')],
        [Markup.button.callback('🗓 Monthly', 'period_monthly')],
        [Markup.button.callback('🏆 Lifetime', 'period_lifetime')],
      ])
    }
  );
});

// ✅ Period selector handler — also handles Refresh button on collective PnL
bot.action(/^period_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Refreshing...");
  const period = ctx.match[1];
  const { text, buttons } = await buildPeriodPnlMessage(period);
  // buttons.length === 1 means only the refresh button, no tokens found
  if (buttons.length <= 1) {
    try { await ctx.editMessageText("📭 No alerts found for the selected period."); } catch {}
    return;
  }
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
  } catch {}
});

bot.command('winrate', async (ctx) => {
  if (alertHistory.size === 0) return ctx.reply('📭 No data to analyze yet.');

  let totalCalls = 0, hitsPeak = 0, hitsStopLoss = 0;
  let totalGainPct = 0, totalLossPct = 0;

  for (const rec of alertHistory.values()) {
    totalCalls++;
    if (rec.peakPrice > rec.alertPrice) {
      hitsPeak++;
      totalGainPct += ((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100;
    }
    if (rec.currentPrice <= (rec.alertPrice * 0.7)) {
      hitsStopLoss++;
      totalLossPct += 30;
    }
  }

  const neutrals = Math.max(0, totalCalls - hitsPeak - hitsStopLoss);
  const hitRate = ((hitsPeak / totalCalls) * 100).toFixed(1);
  const netPnl = totalGainPct - totalLossPct;
  const avgPerTrade = (netPnl / totalCalls).toFixed(1);
  const winRate = totalGainPct + totalLossPct > 0
    ? ((totalGainPct / (totalGainPct + totalLossPct)) * 100).toFixed(1)
    : '0.0';

  const netEmoji = netPnl >= 0 ? '🟢' : '🔴';
  const winEmoji = parseFloat(winRate) >= 50 ? '🟢' : '🔴';
  const avgEmoji = parseFloat(avgPerTrade) >= 0 ? '🟢' : '🔴';

  const lines = [
    `📊 *Bot Performance Summary*`, ``,
    `• *Total Tokens Called:* ${totalCalls}`,
    `• *Pumped Above Entry:* ${hitsPeak}`,
    `• *Hit 30% Stop Loss:* ${hitsStopLoss}`,
    `• *Neutral (no move):* ${neutrals}`,
    `• *Hit Rate:* ${hitsPeak}/${totalCalls} (${hitRate}%)`, ``,
    `💹 *Net Gain:* 🟢 +${totalGainPct.toFixed(1)}%`,
    `🔻 *Net Loss:* 🔴 -${totalLossPct.toFixed(1)}%`,
    `📉 *Net PnL:* ${netEmoji} ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(1)}%`,
    `🎯 *Avg Per Trade:* ${avgEmoji} ${parseFloat(avgPerTrade) >= 0 ? '+' : ''}${avgPerTrade}%`,
    `📈 *Win Rate:* ${winEmoji} ${winRate}%`,
  ];

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// ── Helper: build single token PnL message + buttons ──
async function buildTokenPnlMessage(address: string): Promise<{ text: string; buttons: any[] } | null> {
  const rec = alertHistory.get(address);
  if (!rec) return null;

  const alertDate = new Date(rec.alertTime).toUTCString();
  const peakDate = new Date(rec.peakTime).toUTCString();
  const peakPnlPct = rec.peakPrice > 0 && rec.alertPrice > 0
    ? ((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100 : 0;
  const currentPnlPct = rec.currentPrice > 0 && rec.alertPrice > 0
    ? ((rec.currentPrice - rec.alertPrice) / rec.alertPrice) * 100 : 0;
  const peakMcapGain = rec.alertMcap > 0
    ? ((rec.peakMcap - rec.alertMcap) / rec.alertMcap) * 100 : 0;
  const neverPumped = rec.peakPrice <= rec.alertPrice;

  const lines = [
    `📊 *PnL Report: $${escapeText(rec.ticker)}*`, ``,
    `*Address:* \`${address}\``,
    `*Alerted:* ${escapeText(alertDate)}`, ``,
    `*MCAP at Alert:* $${rec.alertMcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `*Price at Alert:* $${rec.alertPrice.toFixed(8)}`, ``,
  ];

  if (neverPumped) {
    lines.push(`❌ *Did not pump above alert price*`);
    lines.push(`*Current Price:* $${rec.currentPrice.toFixed(8)}`);
    lines.push(`*Current PnL:* 🔴 ${currentPnlPct.toFixed(2)}%`);
  } else {
    lines.push(`🚀 *Peak Performance:*`);
    lines.push(`• Peak Price: $${rec.peakPrice.toFixed(8)}`);
    lines.push(`• Peak MCAP: $${rec.peakMcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    lines.push(`• Peak Gain: 🟢 +${peakPnlPct.toFixed(2)}%`);
    lines.push(`• MCAP Gain: +${peakMcapGain.toFixed(1)}%`);
    lines.push(`• Peak Time: ${escapeText(peakDate)}`);
    lines.push(``);
    lines.push(`📍 *Current:*`);
    lines.push(`• Price: $${rec.currentPrice.toFixed(8)}`);
    lines.push(`• PnL vs Alert: ${currentPnlPct >= 0 ? '🟢 +' : '🔴 '}${currentPnlPct.toFixed(2)}%`);
  }

  lines.push(``);
  lines.push(`📱 [Monitor Chart Live](https://dexscreener.com/solana/${address})`);

  const buttons = [
    [Markup.button.callback('🔄 Refresh', `refresh_pnl_${address}`)]
  ];

  return { text: lines.join('\n'), buttons };
}

bot.action(/^pnl_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  const result = await buildTokenPnlMessage(address);
  if (!result) return ctx.answerCbQuery('Token not found in history.');
  await ctx.answerCbQuery();

  await ctx.reply(result.text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(result.buttons)
  });
});

// ✅ Refresh handler for individual token PnL
bot.action(/^refresh_pnl_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery('Refreshing...');

  // Fetch latest price before rebuilding
  try {
    const { price: currentPrice, mcap: currentMcap } = await getLivePrice(address);
    if (currentPrice && alertHistory.has(address)) {
      const rec = alertHistory.get(address)!;
      const updated = { ...rec, currentPrice, currentMcap, lastUpdated: Date.now() };
      if (currentPrice > rec.peakPrice) {
        updated.peakPrice = currentPrice;
        updated.peakMcap = currentMcap;
        updated.peakTime = Date.now();
      }
      alertHistory.set(address, updated);
      await saveHistory();
    }
  } catch {}

  const result = await buildTokenPnlMessage(address);
  if (!result) return;

  await ctx.editMessageText(result.text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(result.buttons)
  });
});

// ✅ /report — exports full trade history as a downloadable CSV
bot.command('report', async (ctx) => {
  if (alertHistory.size === 0) return ctx.reply('📭 No trade history to export.');

  const headers = 'Ticker,Address,Alert Time,Alert MCAP,Alert Price,Peak MCAP,Peak Price,Peak Gain %,Current Price,Current PnL %,Exit Reason,Exit Price,Exit MCAP,Exit Time\n';

  const rows = Array.from(alertHistory.values())
    .sort((a, b) => b.alertTime - a.alertTime)
    .map(rec => {
      const peakGain = rec.alertPrice > 0
        ? (((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(2)
        : '0';
      const currentPnl = rec.alertPrice > 0
        ? (((rec.currentPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(2)
        : '0';
      const alertDate = new Date(rec.alertTime).toUTCString();
      const exitReason = rec.exitReason || 'OPEN';
      const exitPrice = rec.exitPrice ? rec.exitPrice.toFixed(8) : '-';
      const exitMcap = rec.exitMcap ? rec.exitMcap.toFixed(0) : '-';
      const exitTime = rec.exitTime ? new Date(rec.exitTime).toUTCString() : '-';
      return `${rec.ticker},${rec.address},"${alertDate}",${rec.alertMcap.toFixed(0)},${rec.alertPrice.toFixed(8)},${rec.peakMcap.toFixed(0)},${rec.peakPrice.toFixed(8)},${peakGain}%,${rec.currentPrice.toFixed(8)},${currentPnl}%,${exitReason},${exitPrice},${exitMcap},"${exitTime}"`;
    })
    .join('\n');

  const csv = headers + rows;
  const buffer = Buffer.from(csv, 'utf-8');

  await ctx.replyWithDocument({
    source: buffer,
    filename: `alpha-report-${new Date().toISOString().slice(0, 10)}.csv`
  });
  console.log(`📤 Report exported: ${alertHistory.size} trades`);
});

// ── Helper: build settings panel message + keyboard ──
function buildSettingsMessage() {
  const walletLine = executor.hasWallet()
    ? `🟢 *Wallet:* \`${executor.getWalletPublicKey().slice(0, 8)}...${executor.getWalletPublicKey().slice(-4)}\``
    : `🔴 *Wallet:* Not configured — auto\\-buy is disabled`;

  const text = [
    `⚙️ *Bot Settings*`, ``,
    walletLine,
    `💰 *Trade Size:* ${botSettings.tradeSizeSol} SOL per trade`,
    `🎯 *Take Profit:* +${botSettings.takeProfitPct}%`,
    `🛑 *Stop Loss:* \\-${botSettings.stopLossPct}%`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Set Wallet Private Key', 'set_wallet_key')],
    [Markup.button.callback('💰 Set Trade Size (SOL)', 'set_trade_size')],
    [Markup.button.callback('🎯 Set Take Profit %', 'set_tp')],
    [Markup.button.callback('🛑 Set Stop Loss %', 'set_sl')],
  ]);

  return { text, keyboard };
}

// ── /settings ──
bot.command('settings', async (ctx) => {
  const { text, keyboard } = buildSettingsMessage();
  await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
});

// ── Callbacks: each button puts the chat into an awaiting state ──
bot.action('set_wallet_key', async (ctx) => {
  await ctx.answerCbQuery();
  awaitingInput.set(ctx.chat!.id.toString(), 'privateKey');
  await ctx.reply(
    `🔑 *Paste your Solana wallet private key* \\(base58\\) in the next message\\.\n\n` +
    `⚠️ Your message will be deleted immediately after processing\\.\n` +
    `🔒 The key is encrypted with AES\\-256\\-GCM before storage — never plain text\\.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('set_trade_size', async (ctx) => {
  await ctx.answerCbQuery();
  awaitingInput.set(ctx.chat!.id.toString(), 'tradeSize');
  await ctx.reply(
    `💰 *Enter trade size in SOL*\n\nExample: \`0.15\` or \`0.5\`\n\nCurrent: *${botSettings.tradeSizeSol} SOL*`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('set_tp', async (ctx) => {
  await ctx.answerCbQuery();
  awaitingInput.set(ctx.chat!.id.toString(), 'tp');
  await ctx.reply(
    `🎯 *Enter Take Profit percentage*\n\nExample: \`50\` closes the trade at \\+50%\n\nCurrent: *${botSettings.takeProfitPct}%*`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('set_sl', async (ctx) => {
  await ctx.answerCbQuery();
  awaitingInput.set(ctx.chat!.id.toString(), 'sl');
  await ctx.reply(
    `🛑 *Enter Stop Loss percentage*\n\nExample: \`35\` closes the trade if it drops \\-35% from entry\n\nCurrent: *${botSettings.stopLossPct}%*`,
    { parse_mode: 'Markdown' }
  );
});

// ── Text handler: routes input to the correct setting ──
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const waiting = awaitingInput.get(chatId);
  if (!waiting) return;

  awaitingInput.delete(chatId);
  const input = ctx.message.text.trim();

  if (waiting === 'privateKey') {
    try { await ctx.deleteMessage(); } catch {}
    try {
      const keyBytes = bs58.decode(input);
      if (keyBytes.length !== 64) throw new Error(`Expected 64-byte key, got ${keyBytes.length}`);
      const keypair = Keypair.fromSecretKey(keyBytes);
      const publicKey = keypair.publicKey.toBase58();
      await saveEncryptedWallet(chatId, input);
      executor.setWallet(keypair);
      await ctx.reply(
        `✅ *Wallet Set*\n\n*Public Key:* \`${publicKey}\`\n\nAuto\\-buy is now enabled\\.`,
        { parse_mode: 'Markdown' }
      );
      console.log(`✅ Wallet set via /settings: ${publicKey.slice(0, 8)}...`);
    } catch (e: any) {
      await ctx.reply(`❌ *Invalid private key*\n\n${escapeText(e.message)}\n\nTry again with /settings`, { parse_mode: 'Markdown' });
    }
    return;
  }

  const value = parseFloat(input);
  if (isNaN(value) || value <= 0) {
    await ctx.reply(`❌ Invalid value — enter a positive number\\.`, { parse_mode: 'Markdown' });
    return;
  }

  if (waiting === 'tradeSize') {
    if (value > 10) {
      await ctx.reply(`❌ Trade size capped at 10 SOL for safety\\.`, { parse_mode: 'Markdown' });
      return;
    }
    botSettings.tradeSizeSol = value;
    await saveSetting(chatId, 'tradeSizeSol', value);
    await ctx.reply(`✅ *Trade size set to ${value} SOL per trade*`, { parse_mode: 'Markdown' });
  } else if (waiting === 'tp') {
    if (value > 1000) {
      await ctx.reply(`❌ Take profit capped at 1000%\\.`, { parse_mode: 'Markdown' });
      return;
    }
    botSettings.takeProfitPct = value;
    await saveSetting(chatId, 'takeProfitPct', value);
    await ctx.reply(`✅ *Take profit set to +${value}%*`, { parse_mode: 'Markdown' });
  } else if (waiting === 'sl') {
    if (value > 100) {
      await ctx.reply(`❌ Stop loss capped at 100%\\.`, { parse_mode: 'Markdown' });
      return;
    }
    botSettings.stopLossPct = value;
    await saveSetting(chatId, 'stopLossPct', value);
    await ctx.reply(`✅ *Stop loss set to \\-${value}%*`, { parse_mode: 'Markdown' });
  }
});

// ✅ Heartbeat — console only, NOT Telegram
setInterval(() => {
  console.log('⏱️ Heartbeat: Bot is awake and monitoring the market...');
}, 15 * 60 * 1000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
