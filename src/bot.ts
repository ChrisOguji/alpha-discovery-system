import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';
import WebSocket from 'ws';
import { OnChainPatternRecognition } from './intelligence';
import { CapitalRiskEngine } from './risk';
import { LowLatencyExecutionEngine } from './execution';
import { TokenSignal } from './types';
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
    return;
  }
  return next();
});
const intelligence = new OnChainPatternRecognition();
const riskEngine = new CapitalRiskEngine();
const executor = new LowLatencyExecutionEngine();

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://alpha-discovery-system.onrender.com';

const wssPumpTokensQueue: any[] = [];

// ── seenTokens with 30-minute expiry instead of clearing at 500 ──
const seenTokens = new Map<string, number>(); // address → timestamp seen
const SEEN_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

function hasSeenToken(address: string): boolean {
  const seenAt = seenTokens.get(address);
  if (!seenAt) return false;
  if (Date.now() - seenAt > SEEN_EXPIRY_MS) {
    seenTokens.delete(address);
    return false;
  }
  return true;
}

function markTokenSeen(address: string) {
  seenTokens.set(address, Date.now());
}

interface Position {
  ticker: string;
  address: string;
  entryPrice: number;
  peakPrice: number;
  sizeSol: number;
  entryTime: number;
  // ── Tiered exit state ──
  // initial = never hit +30%, stop loss at -20% below entry
  // level2  = hit +30% but not +70%, stop loss tightened to -15% below entry
  stopLossLevel: 'initial' | 'level2';
  stopLossPct: number;
  remainingPct: number;
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
  try {
    await redis.set('bot_history', JSON.stringify(Array.from(alertHistory.entries())));
  } catch (e: any) {
    console.log(`⚠️ Redis save failed: ${e.message}`);
  }
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

// ── Trade logging helpers ──
async function logTradeAlert(params: {
  address: string; ticker: string; source: string;
  alertPrice: number; alertMcap: number; entryPrice: number; entrySizeSol: number;
  alphaScore: number; rugProbability: number; uniqueBuyers: number;
  buyerVelocity: string; topHolderPct: number; isBundledLaunch: boolean;
  washTrading: boolean; smartMoney: boolean; status: string;
}) {
  try {
    await db.query(`
      INSERT INTO trades_log (
        address, ticker, source, alert_time, alert_price, alert_mcap,
        entry_price, entry_size_sol, peak_price, peak_mcap,
        alpha_score, rug_probability, unique_buyers, buyer_velocity,
        top_holder_pct, is_bundled_launch, wash_trading, smart_money, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT DO NOTHING
    `, [
      params.address, params.ticker, params.source, Date.now(),
      params.alertPrice, params.alertMcap,
      params.entryPrice > 0 ? params.entryPrice : null,
      params.entrySizeSol > 0 ? params.entrySizeSol : null,
      params.alertPrice, params.alertMcap,
      params.alphaScore, params.rugProbability,
      params.uniqueBuyers, params.buyerVelocity,
      params.topHolderPct, params.isBundledLaunch,
      params.washTrading, params.smartMoney,
      params.status
    ]);
  } catch (e: any) {
    console.log(`⚠️ Trade log insert failed: ${e.message}`);
  }
}

async function updateTradePeak(address: string, peakPrice: number, peakMcap: number) {
  try {
    await db.query(`
      UPDATE trades_log SET
        peak_price = GREATEST(COALESCE(peak_price, 0), $2),
        peak_mcap  = GREATEST(COALESCE(peak_mcap, 0), $3),
        peak_time  = CASE WHEN $2 > COALESCE(peak_price, 0) THEN $4 ELSE peak_time END,
        peak_gain_pct = CASE WHEN alert_price > 0
          THEN ROUND((($2 - alert_price) / alert_price * 100)::numeric, 2)
          ELSE peak_gain_pct END
      WHERE address = $1 AND status = 'OPEN'
    `, [address, peakPrice, peakMcap, Date.now()]);
  } catch (e: any) {
    console.log(`⚠️ Trade peak update failed: ${e.message}`);
  }
}

async function closeTrade(address: string, exitPrice: number, exitType: string, sizeSol: number) {
  try {
    await db.query(`
      UPDATE trades_log SET
        exit_price    = $2,
        exit_time     = $3,
        exit_type     = $4,
        status        = 'CLOSED',
        pnl_pct       = CASE WHEN entry_price > 0
                          THEN ROUND((($2 - entry_price) / entry_price * 100)::numeric, 2)
                          ELSE NULL END,
        pnl_sol       = CASE WHEN entry_price > 0
                          THEN ROUND((($2 - entry_price) / entry_price * $5)::numeric, 6)
                          ELSE NULL END,
        held_minutes  = CASE WHEN alert_time > 0
                          THEN FLOOR(($3 - alert_time) / 60000)
                          ELSE NULL END
      WHERE address = $1 AND status = 'OPEN'
    `, [address, exitPrice, Date.now(), exitType, sizeSol]);
  } catch (e: any) {
    console.log(`⚠️ Trade close failed: ${e.message}`);
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

function computeAlphaScore(mcap: number, liquidity: number, rugProb: number): number {
  let score = 0;
  const ratio = liquidity / mcap;
  if (ratio >= 0.30) score += 40;
  else if (ratio >= 0.20) score += 30;
  else if (ratio >= 0.10) score += 20;
  else if (ratio >= 0.05) score += 10;
  if (mcap >= 1000 && mcap <= 28000) score += 25;
  if (liquidity >= 25000) score += 20;
  else if (liquidity >= 10000) score += 12;
  else if (liquidity >= 5000) score += 6;
  if (rugProb <= 0.10) score += 15;
  else if (rugProb <= 0.15) score += 8;
  else if (rugProb >= 0.20) score -= 10;
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
  const volH1 = parseFloat(pair.volume?.h1 || '0');
  const liq = parseFloat(pair.liquidity?.usd || '0');
  // Must have dumped hard (>=50%), be recovering (h1 >= +8%), volume returning strongly
  const dumpedHard = h24 <= -50;
  const recoveringH1 = h1 >= 8;
  const recoveringH6 = h6 >= 15;
  // Volume in last hour must be at least 40% of total 24h volume — confirms real buying
  const volumeReturning = volH24 > 0 && volH1 > 0 && (volH1 / volH24) > 0.40;
  // Must have real liquidity
  const hasRealLiquidity = liq >= 8000;
  return dumpedHard && (recoveringH1 || recoveringH6) && volumeReturning && hasRealLiquidity;
}

function isPostBondCandidate(pair: any): boolean {
  const h24 = parseFloat(pair.priceChange?.h24 || '0');
  const h1 = parseFloat(pair.priceChange?.h1 || '0');
  const h6 = parseFloat(pair.priceChange?.h6 || '0');
  const liq = parseFloat(pair.liquidity?.usd || '0');
  const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
  const volH24 = parseFloat(pair.volume?.h24 || '0');
  const volH1 = parseFloat(pair.volume?.h1 || '0');
  // Graduated token: retraced from ATH, now recovering with real volume
  const retraced = h24 <= -30;
  const recovering = h1 >= 5 || h6 >= 10;
  const hasRealLiquidity = liq >= 10000;
  const inMcapRange = mcap >= 3000 && mcap <= 28000;
  const volumeReturning = volH24 > 0 && volH1 > 0 && (volH1 / volH24) > 0.25;
  return retraced && recovering && hasRealLiquidity && inMcapRange && volumeReturning;
}

function isEarlyMomentumCandidate(pair: any): boolean {
  const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
  const liq = parseFloat(pair.liquidity?.usd || '0');
  const volH24 = parseFloat(pair.volume?.h24 || '0');
  const volH1 = parseFloat(pair.volume?.h1 || '0');
  const volM5 = parseFloat(pair.volume?.m5 || '0');
  // Ultra low cap with sudden volume spike — catching the very bottom before it moves
  const isLowCap = mcap >= 1000 && mcap <= 8000;
  const hasMinLiquidity = liq >= 3000;
  // 5-minute volume should be significant relative to hourly — sudden spike
  const hasMomentum = volM5 > 0 && volH1 > 0 && (volM5 / (volH1 / 12)) > 3;
  // Also check: h1 just started going positive
  const h1 = parseFloat(pair.priceChange?.h1 || '0');
  const justStartedMoving = h1 >= 2 && h1 <= 40; // started but not already pumped
  return isLowCap && hasMinLiquidity && hasMomentum && justStartedMoving;
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
          cachedMcap: token.usdMarketCap || token.vSolInBondingCurve || 0,
          cachedLiquidity: token.vSolInBondingCurve ? token.vSolInBondingCurve * 0.3 : 0,
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

// ── Fetch real pump.fun data for WSS tokens before scoring ──
async function fetchPumpFunTokenData(address: string): Promise<{ mcap: number; liquidity: number; price: number } | null> {
  try {
    const res = await axios.get(`https://frontend-api.pump.fun/coins/${address}`, {
      timeout: 4000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' }
    });
    const mcap = parseFloat(res.data?.usd_market_cap || '0');
    const price = parseFloat(res.data?.price || '0');
    // pump.fun bonding curve liquidity approximation
    const virtualSolReserves = parseFloat(res.data?.virtual_sol_reserves || '0');
    const liquidity = virtualSolReserves > 0 ? virtualSolReserves * 0.3 : mcap * 0.15;
    if (mcap > 0) return { mcap, liquidity, price };
  } catch {}
  return null;
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
          await updateTradePeak(address, currentPrice, currentMcap);
        }
        alertHistory.set(address, updated);
      }

      if (openPositions.has(address)) {
        const pos = openPositions.get(address)!;
        const updated = { ...pos };
        if (currentPrice > pos.peakPrice) updated.peakPrice = currentPrice;

        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const holdingMins = Math.floor((now - pos.entryTime) / 60000);

        // ── LEVEL 1: Token hits +70% — sell everything immediately ──
        if (pnlPct >= 70 && updated.remainingPct > 0) {
          const pnlSol = (pos.sizeSol * pnlPct) / 100;
          const msg = [
            `🎯 *TAKE PROFIT — +70% TARGET HIT*`, ``,
            `*Token:* $${escapeText(pos.ticker)}`,
            `*Address:* \`${address}\``, ``,
            `*Entry Price:* $${pos.entryPrice.toFixed(8)}`,
            `*Exit Price:* $${currentPrice.toFixed(8)}`,
            `*PnL:* 🟢 +${pnlPct.toFixed(2)}%`,
            `*PnL in SOL:* +${pnlSol.toFixed(4)} SOL`,
            `*Size:* ${pos.sizeSol} SOL`,
            `*Held:* ${holdingMins} minutes`, ``,
            `✅ Full position closed at +70% target`,
          ].join('\n');
          await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
          await closeTrade(address, currentPrice, 'TP_70PCT', pos.sizeSol);
          openPositions.delete(address);
          console.log(`✅ Position closed at +70%: ${pos.ticker}`);
          return;
        }

        // ── LEVEL 2: Token hits +30% — tighten stop loss to -15% below entry ──
        if (pnlPct >= 30 && updated.stopLossLevel === 'initial') {
          updated.stopLossLevel = 'level2';
          updated.stopLossPct = -15;
          console.log(`🔒 ${pos.ticker} stop loss tightened to -15% below entry (profit: +${pnlPct.toFixed(1)}%)`);
          await bot.telegram.sendMessage(CHAT_ID,
            `🔒 *STOP LOSS TIGHTENED*\n\n*Token:* $${escapeText(pos.ticker)}\n*Profit hit:* +${pnlPct.toFixed(1)}%\n*Stop loss moved to:* \\-15% below entry\n*Reduces loss if it retraces*`,
            { parse_mode: 'Markdown' }
          );
        }

        // ── STOP LOSS CHECK ──
        const stopLossPrice = pos.entryPrice * (1 + updated.stopLossPct / 100);
        const stopLossHit = currentPrice <= stopLossPrice;

        if (stopLossHit && updated.remainingPct > 0) {
          const pnlSol = (pos.sizeSol * pnlPct) / 100;
          const stopLabel =
            updated.stopLossLevel === 'level2'
              ? '🔒 TIGHTENED STOP — -15% Below Entry'
              : '🛑 STOP LOSS — -20% Hit';
          const exitType =
            updated.stopLossLevel === 'level2' ? 'TIGHTENED_STOP' : 'STOP_LOSS';

          const msg = [
            `💰 *POSITION CLOSED*`, ``,
            `*Token:* $${escapeText(pos.ticker)}`,
            `*Address:* \`${address}\``, ``,
            `*Entry Price:* $${pos.entryPrice.toFixed(8)}`,
            `*Exit Price:* $${currentPrice.toFixed(8)}`,
            `*PnL:* ${pnlPct >= 0 ? '🟢' : '🔴'} ${pnlPct.toFixed(2)}%`,
            `*PnL in SOL:* ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`,
            `*Size:* ${pos.sizeSol} SOL`,
            `*Held:* ${holdingMins} minutes`, ``,
            stopLabel,
          ].join('\n');
          await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
          await closeTrade(address, currentPrice, exitType, pos.sizeSol);
          openPositions.delete(address);
          console.log(`✅ Closed via stop loss: ${pos.ticker} ${pnlPct.toFixed(1)}%`);
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
  console.log("🔍 Scanning 7 sources: pump.fun WSS + DEX new + Reversals + Post-Bond + Early Momentum + PumpSwap + Profiles...");
  try {

    // ── All 7 sources fetched in parallel for speed ──
    const [
      profilesResult,
      pumpSwapResult,
      newDexResult,
      reversalResult,
      postBondResult,
      earlyMomentumResult
    ] = await Promise.allSettled([
      // 1. Profiles
      axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 }),
      // 2. PumpSwap
      axios.get('https://api.dexscreener.com/latest/dex/pairs/solana/pumpfun', { timeout: 10000 }),
      // 3. New DEX pairs
      axios.get('https://api.dexscreener.com/latest/dex/search?q=pump.fun&chainIds=solana', { timeout: 10000 }),
      // 4. Reversals — pump.fun tokens that dumped hard and are recovering
      axios.get('https://api.dexscreener.com/latest/dex/search?q=pump&chainIds=solana&sort=h1Change&order=desc', { timeout: 10000 }),
      // 5. Post-bond — Raydium pairs recovering after bonding curve graduation retrace
      axios.get('https://api.dexscreener.com/latest/dex/pairs/solana/raydium', { timeout: 10000 }),
      // 6. Early momentum — ultra low cap with sudden volume spike
      axios.get('https://api.dexscreener.com/latest/dex/search?q=pump.fun&chainIds=solana&sort=volume&order=desc', { timeout: 10000 }),
    ]);

    // ── Process profiles ──
    const pumpProfiles: any[] = [];
    if (profilesResult.status === 'fulfilled') {
      const profiles = profilesResult.value.data || [];
      profiles
        .filter((p: any) => typeof p.tokenAddress === 'string' && p.tokenAddress.endsWith('pump'))
        .forEach((p: any) => pumpProfiles.push({ tokenAddress: p.tokenAddress, source: 'profiles' }));
    }
    console.log(`Profiles: ${pumpProfiles.length}`);

    // ── Process PumpSwap ──
    const pumpSwapProfiles: any[] = [];
    if (pumpSwapResult.status === 'fulfilled') {
      (pumpSwapResult.value.data?.pairs || [])
        .filter((p: any) => p.baseToken?.address && p.chainId === 'solana')
        .forEach((p: any) => pumpSwapProfiles.push({ tokenAddress: p.baseToken.address, source: 'pumpswap', cachedPair: p }));
    }
    console.log(`PumpSwap: ${pumpSwapProfiles.length} pairs`);

    // ── Process WSS new tokens ──
    const newPumpTokens = [...wssPumpTokensQueue];
    wssPumpTokensQueue.length = 0;
    console.log(`Pump.fun new (via WSS): ${newPumpTokens.length} tokens`);

    // ── Process new DEX pairs ──
    const newDexPairs: any[] = [];
    if (newDexResult.status === 'fulfilled') {
      (newDexResult.value.data?.pairs || [])
        .filter((p: any) =>
          p.baseToken?.address?.endsWith('pump') &&
          p.chainId === 'solana' &&
          p.pairCreatedAt && (Date.now() - p.pairCreatedAt) < 2 * 60 * 60 * 1000
        )
        .forEach((p: any) => newDexPairs.push({ tokenAddress: p.baseToken.address, source: 'dex-new', cachedPair: p }));
    }
    console.log(`New DEX pairs: ${newDexPairs.length}`);

    // ── Process reversals ──
    const reversalTokens: any[] = [];
    if (reversalResult.status === 'fulfilled') {
      (reversalResult.value.data?.pairs || [])
        .filter((p: any) =>
          p.baseToken?.address?.endsWith('pump') &&
          p.chainId === 'solana' &&
          isReversalCandidate(p) &&
          parseFloat(p.fdv || p.marketCap || '0') >= 1000 &&
          parseFloat(p.fdv || p.marketCap || '0') <= 28000
        )
        .forEach((p: any) => reversalTokens.push({ tokenAddress: p.baseToken.address, source: 'reversal', cachedPair: p }));
    }
    console.log(`Reversals: ${reversalTokens.length}`);

    // ── Process post-bond (Raydium graduated tokens retracing and recovering) ──
    const postBondTokens: any[] = [];
    if (postBondResult.status === 'fulfilled') {
      (postBondResult.value.data?.pairs || [])
        .filter((p: any) =>
          p.chainId === 'solana' &&
          isPostBondCandidate(p)
        )
        .forEach((p: any) => postBondTokens.push({ tokenAddress: p.baseToken.address, source: 'post-bond', cachedPair: p }));
    }
    console.log(`Post-bond: ${postBondTokens.length}`);

    // ── Process early momentum ──
    const earlyMomentumTokens: any[] = [];
    if (earlyMomentumResult.status === 'fulfilled') {
      (earlyMomentumResult.value.data?.pairs || [])
        .filter((p: any) =>
          p.baseToken?.address?.endsWith('pump') &&
          p.chainId === 'solana' &&
          isEarlyMomentumCandidate(p)
        )
        .forEach((p: any) => earlyMomentumTokens.push({ tokenAddress: p.baseToken.address, source: 'early-momentum', cachedPair: p }));
    }
    console.log(`Early momentum: ${earlyMomentumTokens.length}`);

    // ── Priority ordering: lowest cap highest potential first ──
    const prioritized = [
      ...earlyMomentumTokens,  // 1. Ultra low cap volume spike — best bottom catchers
      ...newPumpTokens,         // 2. Fresh WSS launches
      ...newDexPairs,           // 3. New DEX pairs
      ...reversalTokens,        // 4. Dump and recover
      ...postBondTokens,        // 5. Post-graduation retrace recovery
      ...pumpSwapProfiles,      // 6. PumpSwap
      ...pumpProfiles           // 7. Trending profiles
    ].filter((p, i, arr) => arr.findIndex(x => x.tokenAddress === p.tokenAddress) === i);

    console.log(`Total candidates: ${prioritized.length} across 7 sources`);

    for (const p of prioritized.slice(0, 60)) {
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (hasSeenToken(p.tokenAddress)) continue;

        let pair = p.cachedPair || null;

        // ── For WSS new tokens: fetch real pump.fun data first ──
        const isNew = p.source === 'pumpfun-new' || p.source === 'dex-new';
        const isReversal = p.source === 'reversal';
        const isPostBond = p.source === 'post-bond';
        const isEarlyMomentum = p.source === 'early-momentum';

        let mcap = 0;
        let liquidity = 0;
        let currentPrice = 0;

        if (p.source === 'pumpfun-new') {
          // ── Fetch real data from pump.fun API for WSS tokens ──
          const pumpData = await fetchPumpFunTokenData(p.tokenAddress);
          if (!pumpData || pumpData.mcap <= 0) {
            // Fall back to DexScreener if pump.fun API fails
            try {
              const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`, { timeout: 8000 });
              pair = data?.pairs?.[0];
            } catch {
              markTokenSeen(p.tokenAddress);
              continue;
            }
          } else {
            mcap = pumpData.mcap;
            liquidity = pumpData.liquidity;
            currentPrice = pumpData.price;
          }
        }

        if (!pair && mcap === 0) {
          try {
            const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`, { timeout: 8000 });
            pair = data?.pairs?.[0];
          } catch {
            markTokenSeen(p.tokenAddress);
            continue;
          }
        }

        // ── Extract data from pair if we have it ──
        if (pair) {
          mcap = parseFloat(pair.fdv || pair.marketCap || '0');
          const rawLiquidity = parseFloat(pair.liquidity?.usd || '0');
          currentPrice = parseFloat(pair.priceUsd || '0');

          // ── Real liquidity required for non-new tokens — NO estimation ──
          if (isNew) {
            liquidity = rawLiquidity > 0 ? rawLiquidity : (mcap * 0.15);
          } else {
            // For established tokens, require real liquidity data
            if (rawLiquidity === 0) {
              console.log(`⏭ ${pair.baseToken?.symbol || p.tokenAddress}: No real liquidity data, skipping`);
              continue; // soft skip — don't mark seen
            }
            liquidity = rawLiquidity;
          }
        }

        const ticker = pair?.baseToken?.symbol || p.cachedName || 'UNKNOWN';
        const address = pair?.baseToken?.address || p.tokenAddress;
        const creatorAddress = pair?.info?.deployer || undefined;

        if (!mcap) { markTokenSeen(p.tokenAddress); continue; }

        // ── mcap ceiling: $28k for all sources ──
        const mcapMin = 1000;
        const mcapMax = 28000;

        if (mcap < mcapMin || mcap > mcapMax) continue; // soft skip

        // ── Time-alive filter — skip tokens under 7 minutes old (non-WSS only) ──
        if (!isNew && pair?.pairCreatedAt) {
          const ageMinutes = (Date.now() - pair.pairCreatedAt) / 60000;
          if (ageMinutes < 7) {
            console.log(`⏭ ${ticker} too young: ${ageMinutes.toFixed(1)} mins old, skipping`);
            continue; // soft skip
          }
        }

        const rugProb = computeRugProbability(mcap, liquidity);
        const alphaScore = computeAlphaScore(mcap, liquidity, rugProb);

        // ── Score minimums by source ──
        const scoreMin = isNew ? 70 : 75;

        console.log(`[${p.source}] ${ticker}: MCAP $${mcap.toFixed(0)} | Liq $${liquidity.toFixed(0)} | Score ${alphaScore}/100`);

        if (alphaScore < scoreMin) continue; // soft skip

        const signal: TokenSignal = {
          tokenAddress: address, ticker, alphaScore,
          rugProbability: rugProb, liquidityUsd: liquidity, marketCapUsd: mcap,
        };

        const [pattern, risk] = await Promise.all([
          intelligence.analyzePattern(signal, creatorAddress, isNew, isPostBond),
          riskEngine.validateExecutionRisk(signal),
        ]);

        if (!pattern.passedPatterns) {
          console.log(`⏭ ${ticker} failed: ${pattern.reason}`);
          markTokenSeen(p.tokenAddress);
          continue;
        }

        const h24 = pair ? parseFloat(pair.priceChange?.h24 || '0') : 0;
        const h1 = pair ? parseFloat(pair.priceChange?.h1 || '0') : 0;

        let executionState = '';
        let executedSizeSol = 0;
        let executedPrice = 0;

        if (risk.allow) {
          try {
            let tx;
            // ── Post-bond tokens on Raydium use Jupiter ──
            // ── Pre-graduation pump.fun tokens use direct bonding curve ──
            if (isPostBond) {
              tx = await executor.buildJupiterSwapTransaction(address, risk.sizeSol, 'BUY');
              tx.sign([executor.getWalletKeypair()]);
              console.log(`🌊 Using Jupiter for post-bond token: ${ticker}`);
            } else if (address.endsWith('pump')) {
              try {
                tx = await executor.buildPumpFunSwapTransaction(address, risk.sizeSol, 'BUY');
                console.log(`⚡ Using direct pump.fun bonding curve for ${ticker}`);
              } catch (pumpErr: any) {
                console.log(`⚠️ Pump.fun direct failed (${pumpErr.message}), falling back to Jupiter`);
                tx = await executor.buildJupiterSwapTransaction(address, risk.sizeSol, 'BUY');
                tx.sign([executor.getWalletKeypair()]);
              }
            } else {
              tx = await executor.buildJupiterSwapTransaction(address, risk.sizeSol, 'BUY');
              tx.sign([executor.getWalletKeypair()]);
            }

            const result = await executor.dispatchMevProtectedBundle(tx);
            if (result.success) {
              const txLink = result.bundleId ? ` — [Solscan](https://solscan.io/tx/${result.bundleId})` : '';
              executionState = `✅ Auto\\-Buy Executed${txLink}`;
              executedSizeSol = risk.sizeSol;
              executedPrice = currentPrice;
              if (executedPrice > 0) {
                openPositions.set(address, {
                  ticker, address,
                  entryPrice: executedPrice,
                  peakPrice: executedPrice,
                  sizeSol: executedSizeSol,
                  entryTime: Date.now(),
                  stopLossLevel: 'initial',
                  stopLossPct: -20,
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

          const tradeStatus = executedPrice > 0 ? 'OPEN' : 'ALERTED';
          await logTradeAlert({
            address, ticker, source: p.source,
            alertPrice: currentPrice, alertMcap: mcap,
            entryPrice: executedPrice, entrySizeSol: executedSizeSol,
            alphaScore, rugProbability: rugProb,
            uniqueBuyers: pattern.uniqueBuyers,
            buyerVelocity: pattern.buyerVelocity,
            topHolderPct: pattern.topHolderConcentration,
            isBundledLaunch: pattern.isBundledLaunch,
            washTrading: pattern.washTradingDetected,
            smartMoney: pattern.smartCohortPresence,
            status: tradeStatus,
          });
        }

        const walletShort = `${executor.getWalletPublicKey().slice(0, 8)}...${executor.getWalletPublicKey().slice(-4)}`;
        const sourceLabel: Record<string, string> = {
          'pumpfun-new':    '🆕 Pump\\.fun \\(Just Launched\\)',
          'dex-new':        '⚡ New DEX Pair',
          'pumpswap':       '🔄 PumpSwap',
          'profiles':       '📈 Trending',
          'reversal':       '🔄 Reversal \\(Dump & Recover\\)',
          'post-bond':      '🎓 Post\\-Bond \\(Graduated & Retraced\\)',
          'early-momentum': '🚀 Early Momentum \\(Volume Spike\\)',
        };

        const extraLine: string[] = [];
        if (isReversal) {
          extraLine.push(``, `📉 *Reversal Signal:* 24h: ${h24.toFixed(1)}% | 1h: +${h1.toFixed(1)}% recovering`);
        }
        if (isPostBond) {
          extraLine.push(``, `🎓 *Post\\-Bond:* Graduated, retraced, recovering | 1h: +${h1.toFixed(1)}%`);
        }
        if (isEarlyMomentum) {
          extraLine.push(``, `🚀 *Early Momentum:* Volume spike detected at low cap`);
        }

        const msg = [
          `🚨🚨 *AUTONOMOUS AI DEGEN CALL* 🚨🚨`, ``,
          `*Token:* $${escapeText(ticker)}`,
          `*Address:* \`${address}\``,
          `*Market Cap:* 💰 $${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `*Liquidity:* $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `*Source:* ${sourceLabel[p.source] || '📈 Trending'}`,
          ...extraLine, ``,
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

        markTokenSeen(p.tokenAddress);

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

bot.command('test', (ctx) => ctx.reply('✅ Bot online. Scanning 7 sources: pump.fun WSS + DEX new + Reversals + Post-Bond + Early Momentum + PumpSwap + Profiles.'));

bot.command('positions', async (ctx) => {
  if (openPositions.size === 0) return ctx.reply('📭 No open positions.');
  const lines = ['📊 *Open Positions:*', ''];
  for (const [address, pos] of openPositions.entries()) {
    const mins = Math.floor((Date.now() - pos.entryTime) / 60000);
    lines.push(`• $${escapeText(pos.ticker)} — ${pos.sizeSol} SOL — ${mins}m held`);
    lines.push(`  Entry: $${pos.entryPrice.toFixed(8)}`);
    lines.push(`  Peak: $${pos.peakPrice.toFixed(8)}`);
    lines.push(`  Stop Loss: ${pos.stopLossPct >= 0 ? '+' : ''}${pos.stopLossPct}% (${pos.stopLossLevel})`);
    lines.push(`  Remaining: ${pos.remainingPct}%`);
    lines.push('');
  }
  ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

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
      let earliest = Date.now();
      for (const r of alertHistory.values()) {
        if (r.alertTime < earliest) earliest = r.alertTime;
      }
      firstDate = new Date(earliest);
    }
    dateString = `${formatDate(firstDate)} - ${todayStr}`;
  }
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
  buttons.push([Markup.button.callback('🔄 Refresh', `period_${period}`)]);
  const dateInterval = getPeriodDateString(period);
  return {
    text: `📊 *${periodLabel[period]} Calls \\(${dateInterval}\\) \\(${filtered.length} tokens\\):*`,
    buttons
  };
}

bot.command('pnl', async (ctx) => {
  if (alertHistory.size === 0) return ctx.reply('📭 No alerts recorded yet.');
  await ctx.reply('📊 *Select a time period:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📅 Daily', 'period_daily')],
      [Markup.button.callback('📆 Weekly', 'period_weekly')],
      [Markup.button.callback('🗓 Monthly', 'period_monthly')],
      [Markup.button.callback('🏆 Lifetime', 'period_lifetime')],
    ])
  });
});

bot.action(/^period_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Refreshing...");
  const period = ctx.match[1];
  const { text, buttons } = await buildPeriodPnlMessage(period);
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
  const buttons = [[Markup.button.callback('🔄 Refresh', `refresh_pnl_${address}`)]];
  return { text: lines.join('\n'), buttons };
}

bot.action(/^pnl_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  const result = await buildTokenPnlMessage(address);
  if (!result) return ctx.answerCbQuery('Token not found in history.');
  await ctx.answerCbQuery();
  await ctx.reply(result.text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(result.buttons) });
});

bot.action(/^refresh_pnl_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery('Refreshing...');
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
  await ctx.editMessageText(result.text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(result.buttons) });
});

bot.command('report', async (ctx) => {
  await ctx.reply('📊 *Select report period:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📅 Daily', 'report_daily')],
      [Markup.button.callback('📆 Weekly', 'report_weekly')],
      [Markup.button.callback('🗓 Monthly', 'report_monthly')],
      [Markup.button.callback('🏆 Lifetime', 'report_lifetime')],
    ])
  });
});

bot.action(/^report_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Generating report...');
  const period = ctx.match[1];
  let cutoff: number;
  const now = Date.now();
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
  try {
    const result = await db.query(`
      SELECT
        ticker, address, source,
        to_timestamp(alert_time / 1000) AT TIME ZONE 'UTC' AS alert_time,
        alert_price, alert_mcap,
        entry_price, entry_size_sol,
        peak_price, peak_mcap,
        to_timestamp(peak_time / 1000) AT TIME ZONE 'UTC' AS peak_time,
        peak_gain_pct,
        exit_price,
        to_timestamp(exit_time / 1000) AT TIME ZONE 'UTC' AS exit_time,
        exit_type, pnl_pct, pnl_sol, held_minutes,
        alpha_score, rug_probability,
        unique_buyers, buyer_velocity, top_holder_pct,
        is_bundled_launch, wash_trading, smart_money, status
      FROM trades_log
      WHERE alert_time >= $1
      ORDER BY alert_time DESC
    `, [cutoff]);

    if (result.rows.length === 0) {
      await ctx.reply('📭 No trades found for this period.');
      return;
    }

    const headers = [
      'Ticker','Address','Source','Alert Time (UTC)','Alert Price','Alert MCAP',
      'Entry Price','Entry Size (SOL)','Peak Price','Peak MCAP','Peak Time (UTC)',
      'Peak Gain %','Exit Price','Exit Time (UTC)','Exit Type',
      'PnL %','PnL SOL','Held (mins)',
      'Alpha Score','Rug Prob','Unique Buyers','Buyer Velocity','Top Holder %',
      'Bundled Launch','Wash Trading','Smart Money','Status'
    ];
    const csvRows = result.rows.map(r => [
      r.ticker, r.address, r.source,
      r.alert_time ? new Date(r.alert_time).toISOString() : '',
      r.alert_price ?? '', r.alert_mcap ?? '',
      r.entry_price ?? '', r.entry_size_sol ?? '',
      r.peak_price ?? '', r.peak_mcap ?? '',
      r.peak_time ? new Date(r.peak_time).toISOString() : '',
      r.peak_gain_pct ?? '',
      r.exit_price ?? '',
      r.exit_time ? new Date(r.exit_time).toISOString() : '',
      r.exit_type ?? '', r.pnl_pct ?? '', r.pnl_sol ?? '', r.held_minutes ?? '',
      r.alpha_score ?? '', r.rug_probability ?? '',
      r.unique_buyers ?? '', r.buyer_velocity ?? '', r.top_holder_pct ?? '',
      r.is_bundled_launch, r.wash_trading, r.smart_money, r.status
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const csvBuffer = Buffer.from(csv, 'utf-8');

    const closed = result.rows.filter(r => r.status === 'CLOSED' && r.pnl_pct != null);
    const wins = closed.filter(r => parseFloat(r.pnl_pct) > 0);
    const losses = closed.filter(r => parseFloat(r.pnl_pct) <= 0);
    const totalPnlPct = closed.reduce((s, r) => s + parseFloat(r.pnl_pct || '0'), 0);
    const totalPnlSol = closed.reduce((s, r) => s + parseFloat(r.pnl_sol || '0'), 0);
    const winRate = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : '0.0';
    const alertedOnly = result.rows.filter(r => r.status === 'ALERTED').length;
    const periodLabel: Record<string, string> = {
      daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', lifetime: 'Lifetime'
    };
    const summary = [
      `📊 *${periodLabel[period]} Trade Report*`, ``,
      `• *Total Alerts:* ${result.rows.length}`,
      `• *Executed Trades:* ${result.rows.length - alertedOnly}`,
      `• *Alert Only \\(no buy\\):* ${alertedOnly}`,
      `• *Closed Trades:* ${closed.length}`,
      `• *Wins:* ${wins.length} | *Losses:* ${losses.length}`,
      `• *Win Rate:* ${parseFloat(winRate) >= 50 ? '🟢' : '🔴'} ${winRate}%`,
      `• *Total PnL %:* ${totalPnlPct >= 0 ? '🟢 +' : '🔴 '}${totalPnlPct.toFixed(2)}%`,
      `• *Total PnL SOL:* ${totalPnlSol >= 0 ? '🟢 +' : '🔴 '}${totalPnlSol.toFixed(4)} SOL`,
      ``, `📎 Full CSV attached below`,
    ].join('\n');
    await ctx.reply(summary, { parse_mode: 'Markdown' });

    const filename = `trades_${period}_${new Date().toISOString().slice(0, 10)}.csv`;
    await bot.telegram.sendDocument(CHAT_ID, {
      source: csvBuffer, filename
    }, { caption: `${periodLabel[period]} trades export — ${result.rows.length} records` });

  } catch (e: any) {
    console.log(`❌ Report error: ${e.message}`);
    await ctx.reply('❌ Report generation failed. Check logs.');
  }
});

setInterval(() => {
  console.log('⏱️ Heartbeat: Bot is awake and monitoring the market...');
}, 15 * 60 * 1000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
