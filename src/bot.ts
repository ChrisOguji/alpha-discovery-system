import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';
import WebSocket from 'ws';
import { OnChainPatternRecognition } from './intelligence';
import { CapitalRiskEngine } from './risk';
import { LowLatencyExecutionEngine } from './execution';
import { TokenSignal } from './types';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const intelligence = new OnChainPatternRecognition();
const riskEngine = new CapitalRiskEngine();
const executor = new LowLatencyExecutionEngine();

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PORT = Number(process.env.PORT) || 10000;
const DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://alpha-discovery-system.onrender.com';

const seenTokens = new Set<string>();
const wssPumpTokensQueue: any[] = [];
const openPositions = new Map<string, any>();
const alertHistory = new Map<string, any>();

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
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    ws.on('open', () => ws.send(JSON.stringify({ method: 'subscribeNewToken' })));
    ws.on('message', (data: any) => {
        try {
            const token = JSON.parse(data.toString());
            if (token.mint && token.symbol) {
                wssPumpTokensQueue.push({ tokenAddress: token.mint, source: 'pumpfun-new', cachedMcap: token.vSolInBondingCurve || 30000, cachedName: token.symbol, createdAt: Date.now() });
            }
        } catch (e) {}
    });
    ws.on('close', () => setTimeout(startPumpPortalStream, 5000));
}

async function getLivePrice(address: string): Promise<{ price: number; mcap: number }> {
  try {
    const jupRes = await axios.get(`https://api.jup.ag/price/v2?ids=${address}`, { timeout: 4000 });
    const jupPrice = parseFloat(jupRes.data?.data?.[address]?.price || '0');
    if (jupPrice > 0) return { price: jupPrice, mcap: 0 };
  } catch {}
  return { price: 0, mcap: 0 };
}

async function monitorPositions() { /* (Your existing code here) */ }
async function scan() { /* (Your existing code here) */ }

bot.launch({ webhook: { domain: DOMAIN, port: PORT } }).then(() => {
  console.log(`🤖 Bot Live on port ${PORT}`);
  startPumpPortalStream();
  scan();
  setInterval(scan, 60000);
  setInterval(monitorPositions, 30 * 1000);
  setInterval(async () => { try { await axios.get(DOMAIN, { timeout: 5000 }); } catch {} }, 5 * 60 * 1000);
}).catch((err) => process.exit(1));

bot.command('test', (ctx) => ctx.reply('✅ Bot Online'));
// ... (Include your other bot.command / bot.action blocks here)
