import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';
import WebSocket from 'ws';
import { OnChainPatternRecognition } from './intelligence';
import { CapitalRiskEngine } from './risk';
import { LowLatencyExecutionEngine } from './execution';
import { TokenSignal } from './types';
import { db } from './db';
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL || '');

dotenv.config();

const PORT = Number(process.env.PORT) || 10000;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const intelligence = new OnChainPatternRecognition();
const riskEngine = new CapitalRiskEngine();
const executor = new LowLatencyExecutionEngine();

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://alpha-discovery-system.onrender.com';

const seenTokens = new Map<string, number>();
const SEEN_TOKEN_TTL = 2 * 60 * 60 * 1000;

function markTokenSeen(address: string) {
  seenTokens.set(address, Date.now());
}

function isTokenSeen(address: string): boolean {
  const seenAt = seenTokens.get(address);
  if (!seenAt) return false;
  if (Date.now() - seenAt > SEEN_TOKEN_TTL) {
    seenTokens.delete(address);
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [addr, ts] of seenTokens.entries()) {
    if (now - ts > SEEN_TOKEN_TTL) seenTokens.delete(addr);
  }
}, 30 * 60 * 1000);

const wssPumpTokensQueue: any[] = [];

interface Position {
  ticker: string;
  address: string;
  entryPrice: number;
  peakPrice: number;
  sizeSol: number;
  entryTime: number;
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

async function loadPositionsFromDb() {
  try {
    const result = await db.query(`SELECT * FROM active_positions WHERE status = 'OPEN'`);
    for (const row of result.rows) {
      openPositions.set(row.token_address, {
        ticker: row.ticker,
        address: row.token_address,
        entryPrice: parseFloat(row.entry_price_usd),
        peakPrice: parseFloat(row.highest_price_usd || row.entry_price_usd),
        sizeSol: parseFloat(row.size_sol),
        entryTime: parseInt(row.timestamp) || Date.now()
      });
    }
    console.log(`✅ Loaded ${openPositions.size} open positions from Supabase`);
  } catch (err: any) {
    console.log(`⚠️ Could not load positions from DB: ${err.message}`);
  }
}

async function savePositionToDb(address: string, pos: Position) {
  try {
    await db.query(
      `INSERT INTO active_positions (token_address, ticker, entry_price_usd, current_price_usd, size_sol, highest_price_usd, status, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7)
       ON CONFLICT (token_address) DO UPDATE SET
         current_price_usd = EXCLUDED.current_price_usd,
         highest_price_usd = EXCLUDED.highest_price_usd,
         status = EXCLUDED.status`,
      [address, pos.ticker, pos.entryPrice, pos.entryPrice, pos.sizeSol, pos.peakPrice, pos.entryTime]
    );
  } catch (err: any) {
    console.log(`⚠️ DB save position error: ${err.message}`);
  }
}

async function closePositionInDb(address: string) {
  try {
    await db.query(`UPDATE active_positions SET status = 'CLOSED' WHERE token_address = $1`, [address]);
  } catch (err: any) {
    console.log(`⚠️ DB close position error: ${err.message}`);
  }
}

// Load history from Redis on startup
redis.get('bot_history').then((data) => {
  if (data) {
    alertHistory = new Map(JSON.parse(data));
    console.log(`✅ History loaded from Redis: ${alertHistory.size} alerts`);
  }
});

function escapeText(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function saveHistory() {
  await redis.set('bot_history', JSON.stringify(Array.from(alertHistory.entries())));
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
  // ✅ Updated: 70k max
  if (mcap >= 1000 && mcap <= 70000) score += 25;
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
  console.log("🔗 Connecting to PumpPortal WSS (Bypassing Cloudflare)...");
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.on('open', () => {
    console.log("🟢 WSS Connected! Streaming new token launches...");
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
  const allAddresses = new Set([...openPositions.keys(), ...alertHistory.keys()]);
  if (allAddresses.size === 0) return;

  await Promise.all(Array.from(allAddresses).map(async (address) => {
    try {
      const { price: currentPrice, mcap: currentMcap } = await getLivePrice(address);
      if (!currentPrice) return;

      if (alertHistory.has(address)) {
        const rec = alertHistory.get(address)!;
        const updated: AlertRecord = { ...rec, currentPrice, currentMcap, lastUpdated: Date.now() };
        if (currentPrice > rec.peakPrice) {
          updated.peakPrice = currentPrice;
          updated.peakMcap = currentMcap;
          updated.peakTime = Date.now();
          console.log(`📈 New peak ${rec.ticker}: $${currentPrice.toFixed(8)} (+${(((currentPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(1)}%)`);
        }
        alertHistory.set(address, updated);
      }

      if (openPositions.has(address)) {
        const pos = openPositions.get(address)!;
        const now = Date.now();
        const updated = { ...pos };
        if (currentPrice > pos.peakPrice) updated.peakPrice = currentPrice;
        openPositions.set(address, updated);

        try {
          await db.query(
            `UPDATE active_positions SET current_price_usd = $1, highest_price_usd = $2 WHERE token_address = $3`,
            [currentPrice, updated.peakPrice, address]
          );
        } catch {}

        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const dropFromPeak = ((currentPrice - updated.peakPrice) / updated.peakPrice) * 100;
        const holdingMins = Math.floor((now - pos.entryTime) / 60000);

        let exitReason = '';
        if (pnlPct >= 100) exitReason = '🎯 TAKE PROFIT — 2x Hit';
        else if (pnlPct <= -30) exitReason = '🛑 STOP LOSS — \\-30% Hit';
        else if (updated.peakPrice > pos.entryPrice * 1.3 && dropFromPeak <= -20) {
          exitReason = '📉 TRAILING STOP — 20% Drop From Peak';
        }

        if (exitReason) {
          const pnlSol = (pos.sizeSol * pnlPct) / 100;
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
            exitReason,
          ].join('\n');
          await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
          openPositions.delete(address);
          await closePositionInDb(address);
          console.log(`✅ Closed: ${pos.ticker} ${pnlPct.toFixed(1)}%`);
        }
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
      console.log(`New DEX pairs: ${newDexPairs.length} (last 2hrs)`);
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
          // ✅ Updated: 70k max
          parseFloat(p.fdv || p.marketCap || '0') <= 70000
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
        if (isTokenSeen(p.tokenAddress)) continue;

        let pair = p.cachedPair || null;
        if (!pair) {
          try {
            const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`, { timeout: 8000 });
            pair = data?.pairs?.[0];
          } catch {
            markTokenSeen(p.tokenAddress);
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
        if (!mcap) { markTokenSeen(p.tokenAddress); continue; }

        const isNew = p.source === 'pumpfun-new' || p.source === 'dex-new';
        const isReversal = p.source === 'reversal';
        const mcapMin = isNew ? 500 : 1000;

        // ✅ Updated: 70k max
        if (mcap < mcapMin || mcap > 70000) {
          markTokenSeen(p.tokenAddress);
          continue;
        }

        const rugProb = computeRugProbability(mcap, liquidity);
        const alphaScore = computeAlphaScore(mcap, liquidity, rugProb);
        const scoreMin = isNew ? 70 : 75;

        console.log(`[${p.source}] ${ticker}: MCAP $${mcap} | Liq $${liquidity} | Score ${alphaScore}/100`);

        if (alphaScore < scoreMin) { markTokenSeen(p.tokenAddress); continue; }

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
            const tx = await executor.buildJupiterSwapTransaction(address, risk.sizeSol, 'BUY');
            tx.sign([executor.getWalletKeypair()]);
            const result = await executor.dispatchMevProtectedBundle(tx);
            if (result.success) {
              const txLink = result.bundleId ? ` — [Solscan](https://solscan.io/tx/${result.bundleId})` : '';
              executionState = `✅ Auto\\-Buy Executed${txLink}`;
              executedSizeSol = risk.sizeSol;
              executedPrice = currentPrice;
              if (executedPrice > 0) {
                const pos: Position = {
                  ticker, address, entryPrice: executedPrice,
                  peakPrice: executedPrice, sizeSol: executedSizeSol, entryTime: Date.now()
                };
                openPositions.set(address, pos);
                await savePositionToDb(address, pos);
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

        // ✅ Only create new record if not already tracked — preserves original alertTime
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

        markTokenSeen(p.tokenAddress);

      } catch (innerErr: any) {
        console.log(`❌ Error on token: ${innerErr.message}`);
      }
    }
  } catch (e: any) {
    console.error("Global Scan Error:", e.message);
  }
}

bot.launch({
  webhook: { domain: DOMAIN, port: PORT }
}).then(async () => {
  console.log(`🤖 Bot Live via Webhook on port ${PORT}`);
  await loadPositionsFromDb();
  startPumpPortalStream();
  scan();
  setInterval(scan, 60000);
  setInterval(monitorPositions, 30 * 1000);
  setInterval(async () => {
    try {
      await axios.get(DOMAIN, { timeout: 5000 });
      console.log('🏓 Self-ping sent');
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
    lines.push('');
  }
  ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.command('pnl', async (ctx) => {
  if (alertHistory.size === 0) {
    return ctx.reply('📭 No alerts recorded yet. Wait for the bot to call some tokens.');
  }
  await ctx.reply(
    '📊 *Select a time period:*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📅 Today', 'pnl_period_today')],
        [Markup.button.callback('📅 This Week', 'pnl_period_week')],
        [Markup.button.callback('📅 This Month', 'pnl_period_month')],
        [Markup.button.callback('📅 Lifetime', 'pnl_period_lifetime')],
      ])
    }
  );
});

bot.action(/^pnl_period_(.+)$/, async (ctx) => {
  const period = ctx.match[1];
  await ctx.answerCbQuery();

  const now = Date.now();
  let cutoff = 0;
  let periodLabel = '';

  switch (period) {
    case 'today':
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      cutoff = todayStart.getTime();
      periodLabel = 'Today';
      break;
    case 'week':
      cutoff = now - (7 * 24 * 60 * 60 * 1000);
      periodLabel = 'This Week';
      break;
    case 'month':
      cutoff = now - (30 * 24 * 60 * 60 * 1000);
      periodLabel = 'This Month';
      break;
    case 'lifetime':
    default:
      cutoff = 0;
      periodLabel = 'Lifetime';
      break;
  }

  const filtered = Array.from(alertHistory.entries())
    .filter(([_, rec]) => rec.alertTime >= cutoff)
    .sort((a, b) => b[1].alertTime - a[1].alertTime);

  if (filtered.length === 0) return ctx.reply(`📭 No alerts found for period: ${periodLabel}`);

  const buttons = filtered.slice(0, 20).map(([address, rec]) => {
    const pnlPct = rec.peakPrice > rec.alertPrice
      ? (((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(1)
      : '0';
    const label = `$${rec.ticker} | Peak: +${pnlPct}%`;
    return [Markup.button.callback(label, `pnl_${address}`)];
  });

  await ctx.reply(
    `📊 *PnL — ${escapeText(periodLabel)}* (${filtered.length} tokens)`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.command('winrate', async (ctx) => {
  if (alertHistory.size === 0) return ctx.reply('📭 No data to analyze yet.');

  let totalCalls = 0, hitsPeak = 0, hitsStopLoss = 0, totalGainPct = 0, totalLossPct = 0;

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
    ? ((totalGainPct / (totalGainPct + totalLossPct)) * 100).toFixed(1) : '0.0';

  const netEmoji = netPnl >= 0 ? '🟢' : '🔴';
  const winEmoji = parseFloat(winRate) >= 50 ? '🟢' : '🔴';
  const avgEmoji = parseFloat(avgPerTrade) >= 0 ? '🟢' : '🔴';

  await ctx.reply([
    `📊 *Bot Performance Summary*`, ``,
    `• *Total Tokens Called:* ${totalCalls}`,
    `• *Pumped Above Entry:* ${hitsPeak}`,
    `• *Hit 30% Stop Loss:* ${hitsStopLoss}`,
    `• *Neutral \\(no move\\):* ${neutrals}`,
    `• *Hit Rate:* ${hitsPeak}/${totalCalls} \\(${hitRate}%\\)`, ``,
    `💹 *Net Gain:* 🟢 +${totalGainPct.toFixed(1)}%`,
    `🔻 *Net Loss:* 🔴 \\-${totalLossPct.toFixed(1)}%`,
    `📉 *Net PnL:* ${netEmoji} ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(1)}%`,
    `🎯 *Avg Per Trade:* ${avgEmoji} ${parseFloat(avgPerTrade) >= 0 ? '+' : ''}${avgPerTrade}%`,
    `📈 *Win Rate:* ${winEmoji} ${winRate}%`,
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.action(/^pnl_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  if (address.startsWith('period_')) return;

  const rec = alertHistory.get(address);
  if (!rec) return ctx.answerCbQuery('Token not found in history.');
  await ctx.answerCbQuery();

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
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// ✅ Heartbeat — console only, NOT Telegram
setInterval(() => {
  console.log('⏱️ Heartbeat: Bot is awake and monitoring the market...');
}, 15 * 60 * 1000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
