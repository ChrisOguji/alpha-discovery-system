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
const intelligence = new OnChainPatternRecognition();
const riskEngine = new CapitalRiskEngine();
const executor = new LowLatencyExecutionEngine();

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://alpha-discovery-system.onrender.com';

const seenTokens = new Set<string>();
const wssPumpTokensQueue: any[] = [];

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

function computeAlphaScore(mcap: number, liquidity: number, rugProb: number): number {
  let score = 0;
  const ratio = liquidity / mcap;
  if (ratio >= 0.30) score += 40;
  else if (ratio >= 0.20) score += 30;
  else if (ratio >= 0.10) score += 20;
  else if (ratio >= 0.05) score += 10;
  if (mcap >= 1000 && mcap <= 40000) score += 25;
  if (liquidity >= 25000) score += 20;
  else if (liquidity >= 10000) score += 12;
  else if (liquidity >= 5000) score += 6;
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
  const dumpedHard = h24 <= -40;
  const recoveringH1 = h1 >= 5;
  const recoveringH6 = h6 >= 10;
  const volumeReturning = volH6 > 0 && volH24 > 0 && (volH6 / volH24) > 0.3;
  return dumpedHard && (recoveringH1 || recoveringH6) && volumeReturning;
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
          cachedMcap: token.vSolInBondingCurve || 30000,
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

        // ── DYNAMIC TRAILING STOP LOSS ──
        // Level 1: profit hits +10% to +15% → move stop loss to -10% below entry
        if (pnlPct >= 10 && updated.stopLossLevel === 'initial') {
          updated.stopLossLevel = 'breakeven';
          updated.stopLossPct = -10;
          console.log(`🔒 ${pos.ticker} stop loss moved to -10% below entry (profit: +${pnlPct.toFixed(1)}%)`);
          await bot.telegram.sendMessage(CHAT_ID,
            `🔒 *STOP LOSS UPGRADED*\n\n*Token:* $${escapeText(pos.ticker)}\n*Profit hit:* +${pnlPct.toFixed(1)}%\n*Stop loss moved to:* -10% below entry\n*Protected from:* full loss`,
            { parse_mode: 'Markdown' }
          );
        }

        // Level 2: profit hits +25% to +30% → move stop loss to +2% above entry
        if (pnlPct >= 25 && updated.stopLossLevel === 'breakeven') {
          updated.stopLossLevel = 'trailing';
          updated.stopLossPct = 2;
          console.log(`🔒 ${pos.ticker} stop loss moved to +2% above entry (profit: +${pnlPct.toFixed(1)}%)`);
          await bot.telegram.sendMessage(CHAT_ID,
            `🔐 *STOP LOSS IN PROFIT*\n\n*Token:* $${escapeText(pos.ticker)}\n*Profit hit:* +${pnlPct.toFixed(1)}%\n*Stop loss moved to:* +2% above entry\n*This trade cannot lose now*`,
            { parse_mode: 'Markdown' }
          );
        }

        // ── STAGED TAKE PROFIT ──
        // 60% at +100%, 15% at +250%, 15% at +500%, 10% at +900%
        let tpMsg = '';
        let soldPct = 0;

        if (pnlPct >= 100 && updated.remainingPct > 40) {
          soldPct = 60;
          updated.remainingPct = 40;
          tpMsg = `🎯 *TAKE PROFIT 1 — +100%*\n• Sold: 60% of position\n• Remaining: 40%\n• Next TP: +250%`;
        } else if (pnlPct >= 250 && updated.remainingPct > 25) {
          soldPct = 15;
          updated.remainingPct = 25;
          tpMsg = `🎯 *TAKE PROFIT 2 — +250%*\n• Sold: 15% of position\n• Remaining: 25%\n• Next TP: +500%`;
        } else if (pnlPct >= 500 && updated.remainingPct > 10) {
          soldPct = 15;
          updated.remainingPct = 10;
          tpMsg = `🎯 *TAKE PROFIT 3 — +500%*\n• Sold: 15% of position\n• Remaining: 10%\n• Next TP: +900%`;
        } else if (pnlPct >= 900 && updated.remainingPct > 0) {
          soldPct = 10;
          updated.remainingPct = 0;
          tpMsg = `🎯 *TAKE PROFIT 4 — +900%*\n• Sold: final 10% of position\n• Position fully closed`;
        }

        if (tpMsg) {
          const pnlSol = (pos.sizeSol * (soldPct / 100) * pnlPct) / 100;
          const fullMsg = [
            tpMsg, ``,
            `*Token:* $${escapeText(pos.ticker)}`,
            `*Entry:* $${pos.entryPrice.toFixed(8)}`,
            `*Current:* $${currentPrice.toFixed(8)}`,
            `*PnL:* 🟢 +${pnlPct.toFixed(2)}%`,
            `*Profit taken:* +${pnlSol.toFixed(4)} SOL`,
          ].join('\n');
          await bot.telegram.sendMessage(CHAT_ID, fullMsg, { parse_mode: 'Markdown' });

          // If fully exited
          if (updated.remainingPct === 0) {
            openPositions.delete(address);
            console.log(`✅ Position fully closed: ${pos.ticker} at +${pnlPct.toFixed(1)}%`);
            openPositions.set(address, updated);
            return;
          }
        }

        // ── STOP LOSS CHECK — uses dynamic level ──
        const stopLossPrice = pos.entryPrice * (1 + updated.stopLossPct / 100);
        const stopLossHit = currentPrice <= stopLossPrice;

        if (stopLossHit && updated.remainingPct > 0) {
          const pnlSol = (pos.sizeSol * (updated.remainingPct / 100) * pnlPct) / 100;
          const stopLabel =
            updated.stopLossLevel === 'trailing' ? '🔐 TRAILING STOP — +2% Above Entry' :
            updated.stopLossLevel === 'breakeven' ? '🔒 DYNAMIC STOP — -10% Below Entry' :
            '🛑 STOP LOSS — -30% Hit';

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
          parseFloat(p.fdv || p.marketCap || '0') >= 1000 &&
          parseFloat(p.fdv || p.marketCap || '0') <= 40000
        )
        .map((p: any) => ({ tokenAddress: p.baseToken.address, source: 'reversal', cachedPair: p }));
      console.log(`Reversals: ${reversalTokens.length}`);
    } catch (rErr: any) { console.log(`⚠️ Reversal scan failed: ${rErr.message}`); }

    const localSeen = new Set<string>();
    const allCandidates: any[] = [];
    for (const p of [...newPumpTokens, ...newDexPairs, ...reversalTokens, ...pumpSwapProfiles, ...pumpProfiles]) {
      if (!localSeen.has(p.tokenAddress)) {
        localSeen.add(p.tokenAddress);
        allCandidates.push(p);
      }
    }

    console.log(`Total candidates: ${allCandidates.length} across 5 sources`);

    for (const p of allCandidates.slice(0, 40)) {
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
        const mcapMin = isNew ? 500 : 1000;

        if (mcap < mcapMin || mcap > 40000) { seenTokens.add(p.tokenAddress); continue; }

        const rugProb = computeRugProbability(mcap, liquidity);
        const alphaScore = computeAlphaScore(mcap, liquidity, rugProb);
        const scoreMin = isNew ? 70 : 75;

        console.log(`[${p.source}] ${ticker}: MCAP $${mcap} | Liq $${liquidity} | Score ${alphaScore}/100`);

        if (alphaScore < scoreMin) { seenTokens.add(p.tokenAddress); continue; }

        const signal: TokenSignal = {
          tokenAddress: address, ticker, alphaScore,
          rugProbability: rugProb, liquidityUsd: liquidity, marketCapUsd: mcap,
        };

        const [pattern, risk] = await Promise.all([
          intelligence.analyzePattern(signal, creatorAddress),
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

        if (risk.allow) {
          try {
            const tx = await executor.buildJupiterSwapTransaction(address, risk.sizeSol, 'BUY');
            tx.sign([executor.getWalletKeypair()]);
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
                  // ── Start with initial stop loss at -30% ──
                  stopLossLevel: 'initial',
                  stopLossPct: -30,
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

        const walletShort = `${executor.getWalletPublicKey().slice(0, 8)}...${executor.getWalletPublicKey().slice(-4)}`;
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
    lines.push(`  Stop Loss: ${pos.stopLossPct >= 0 ? '+' : ''}${pos.stopLossPct}% (${pos.stopLossLevel})`);
    lines.push(`  Remaining: ${pos.remainingPct}%`);
    lines.push('');
  }
  ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// ── Helper: build collective PnL token list for a period ──
async function buildPeriodPnlMessage(period: string): Promise<{ text: string; buttons: any[] }> {
  const now = Date.now();
  const periodMs: Record<string, number> = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
    lifetime: Infinity
  };
  const cutoff = period === 'lifetime' ? 0 : now - periodMs[period];
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

  return {
    text: `📊 *${periodLabel[period]} Calls \\(${filtered.length} tokens\\):*`,
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

// ✅ Heartbeat — console only, NOT Telegram
setInterval(() => {
  console.log('⏱️ Heartbeat: Bot is awake and monitoring the market...');
}, 15 * 60 * 1000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
