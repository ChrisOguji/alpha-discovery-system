import axios from 'axios';
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';

// ─────────────────────────────────────────────────────────────────────────
// Robinhood Chain / pons launchpad scanner
//
// Mirrors the existing Solana pipeline's shape:
//   - startPonsFactoryListener() is the EVM equivalent of startPumpPortalStream()
//     in bot.ts — it fills a queue that scan() drains each cycle.
//   - getPonsTokenSnapshot() is the EVM equivalent of getLivePrice() — reads
//     price/mcap directly from chain state, for use before DexScreener has
//     indexed a brand-new pool (Robinhood Chain IS indexed by DexScreener,
//     chainIds=robinhood, so prefer that once a pair shows up there).
//
// Scoped intentionally to ONLY the pons factory — this does not scan any
// other Robinhood Chain launchpad (Openfair, NOXA Fun, hood.fun, etc).
//
// Alert flow: launch detected -> wait 30-40 min -> re-check mcap/liquidity/
// graduation/score fresh -> require a filled-out DexScreener profile (logo +
// social/website) -> alert. Anything that never clears all four gets dropped
// after 6 hours.
// ─────────────────────────────────────────────────────────────────────────

export const ROBINHOOD_CHAIN_ID = 4663;
const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

// ── pons active factory (source: docs.ponsfamily.com — "Contracts" section) ──
const PONS_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB' as const;

export const robinhoodClient = createPublicClient({
  chain: {
    id: ROBINHOOD_CHAIN_ID,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
  transport: http(RPC_URL),
});

// ── Event + ABI fragments, copied verbatim from the pons integration docs ──
const tokenLaunchedEvent = parseAbiItem(
  'event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)'
);

const factoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token, address deployer, address pairedToken, address positionManager, uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount) launched)',
  'function graduationStatus(address token) view returns (uint256 pairedPrincipal, uint256 threshold, bool graduated)',
]);

const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

const tokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function liquidityPool() view returns (address)',
]);

// ── Queue: drained by scan() each cycle, same pattern as wssPumpTokensQueue ──
export interface PonsCandidate {
  tokenAddress: string;
  source: 'pons-new';
  deployer: string;
  pool: string;
  ticker: string;
  createdAt: number;
}
export const ponsTokenQueue: PonsCandidate[] = [];

let lastPolledBlock: bigint | null = null;
let ponsPollTimer: ReturnType<typeof setInterval> | null = null;

// ── ETH/USD, cached — pons's own interface prices in USD via DeFiLlama, so we match that ──
let cachedEthUsd = 0;
let cachedEthUsdAt = 0;
const ETH_PRICE_TTL_MS = 60_000;

async function getEthUsd(): Promise<number> {
  const now = Date.now();
  if (cachedEthUsd > 0 && now - cachedEthUsdAt < ETH_PRICE_TTL_MS) return cachedEthUsd;
  try {
    const res = await axios.get('https://coins.llama.fi/prices/current/coingecko:ethereum', { timeout: 5000 });
    const price = res.data?.coins?.['coingecko:ethereum']?.price;
    if (price > 0) {
      cachedEthUsd = price;
      cachedEthUsdAt = now;
    }
  } catch (e: any) {
    console.log(`⚠️ ETH/USD fetch failed, using last cached value: ${e.message}`);
  }
  return cachedEthUsd;
}

// ── Poll the factory for new TokenLaunched events ──
// The public RPC times out on wide eth_getLogs ranges (per pons docs), so this polls in
// small bounded windows on an interval rather than subscribing to a websocket — Robinhood
// Chain's public endpoint is HTTP-only.
export function startPonsFactoryListener(pollIntervalMs = 5000): void {
  if (ponsPollTimer) return;

  console.log('🔗 Starting pons factory listener on Robinhood Chain...');

  const poll = async () => {
    try {
      const latest = await robinhoodClient.getBlockNumber();

      if (lastPolledBlock === null) {
        lastPolledBlock = latest; // start watching from now, not from genesis
        return;
      }
      if (latest <= lastPolledBlock) return;

      const fromBlock = lastPolledBlock + 1n;
      const toBlock = latest;
      lastPolledBlock = latest;

      const logs = await robinhoodClient.getLogs({
        address: PONS_FACTORY,
        event: tokenLaunchedEvent,
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        const { token, deployer, pool } = log.args as {
          token: string;
          deployer: string;
          pool: string;
        };

        let ticker = 'UNKNOWN';
        try {
          ticker = (await robinhoodClient.readContract({
            address: token as `0x${string}`,
            abi: tokenAbi,
            functionName: 'symbol',
          })) as string;
        } catch {
          // keep UNKNOWN — scoring pipeline doesn't hard-depend on this
        }

        ponsTokenQueue.push({
          tokenAddress: token,
          source: 'pons-new',
          deployer,
          pool,
          ticker,
          createdAt: Date.now(),
        });
        console.log(`🆕 pons launch detected: $${ticker} (${token})`);
      }
    } catch (e: any) {
      console.log(`⚠️ pons factory poll error: ${e.message}`);
    }
  };

  poll();
  ponsPollTimer = setInterval(poll, pollIntervalMs);
}

export function stopPonsFactoryListener(): void {
  if (ponsPollTimer) {
    clearInterval(ponsPollTimer);
    ponsPollTimer = null;
  }
  lastPolledBlock = null;
}

// ── Live price/mcap/graduation snapshot, read directly from chain state ──
// Use this as the primary source right after launch, before DexScreener has indexed the
// pool. Once a pair shows up on dexscreener.com (chainIds=robinhood), prefer that the same
// way getLivePrice() prefers Jupiter/pump.fun over raw bonding-curve math on the Solana side.
export interface PonsSnapshot {
  priceUsd: number;
  marketCapUsd: number;
  liquidityWeth: number;
  graduated: boolean;
  graduationProgress: number; // 0–1
}

export async function getPonsTokenSnapshot(tokenAddress: string): Promise<PonsSnapshot | null> {
  try {
    const address = tokenAddress as `0x${string}`;

    const [pool, launched, graduation] = await Promise.all([
      robinhoodClient.readContract({ address, abi: tokenAbi, functionName: 'liquidityPool' }),
      robinhoodClient.readContract({
        address: PONS_FACTORY,
        abi: factoryAbi,
        functionName: 'getLaunchedToken',
        args: [address],
      }),
      robinhoodClient.readContract({
        address: PONS_FACTORY,
        abi: factoryAbi,
        functionName: 'graduationStatus',
        args: [address],
      }),
    ]);

    if (!launched.exists) return null;

    const [sqrtPriceX96] = await robinhoodClient.readContract({
      address: pool as `0x${string}`,
      abi: poolAbi,
      functionName: 'slot0',
    });

    const ratio = Number(sqrtPriceX96) / 2 ** 96;
    const token1PerToken0 = ratio * ratio;
    const priceInWeth = launched.isToken0 ? token1PerToken0 : 1 / token1PerToken0;

    const ethUsd = await getEthUsd();
    const priceUsd = priceInWeth * ethUsd;
    const supplyTokens = Number(launched.supply) / 1e18;
    const marketCapUsd = priceUsd * supplyTokens;

    const [pairedPrincipal, threshold, graduated] = graduation;
    const graduationProgress = threshold > 0n ? Number(pairedPrincipal) / Number(threshold) : 0;

    return {
      priceUsd,
      marketCapUsd,
      liquidityWeth: Number(pairedPrincipal) / 1e18,
      graduated,
      graduationProgress,
    };
  } catch (e: any) {
    console.log(`⚠️ pons snapshot error for ${tokenAddress}: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Self-contained alert pipeline for pons tokens — bot.ts only needs to call
// runPonsScan() once per scan cycle. No auto-buy yet (that's a later step);
// this drains the launch queue, waits out the min age, scores, checks for a
// filled-out DexScreener profile, then sends Telegram alerts.
// ─────────────────────────────────────────────────────────────────────────

const MIN_AGE_MS = 25 * 60 * 1000; // wait ~20-30 min after launch before evaluating
const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000; // give up on a candidate after 6 hours

interface PonsPending extends PonsCandidate {
  firstSeenAt: number;
}
const pendingQueue: PonsPending[] = [];
const ponsSeenTokens = new Set<string>(); // sent or permanently dropped — won't be re-queued

// ── Only alert once DexScreener shows a filled-out profile (logo + at least
// one social/website link) — a decent signal the team is actually building,
// not just deploying and disappearing. ──
async function getDexScreenerEnrichment(tokenAddress: string): Promise<boolean> {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 8000 });
    const pair = (data?.pairs || []).find((p: any) => p.chainId === 'robinhood');
    if (!pair) return false;
    const hasImage = !!pair.info?.imageUrl;
    const hasLinks = (pair.info?.socials?.length || 0) > 0 || (pair.info?.websites?.length || 0) > 0;
    return hasImage && hasLinks;
  } catch {
    return false;
  }
}

async function sendPonsAlert(
  bot: { telegram: { sendMessage: (chatId: string, text: string, extra?: any) => Promise<any> } },
  chatId: string,
  c: { ticker: string; tokenAddress: string },
  mcap: number,
  liquidityUsd: number,
  score: number,
  graduationProgress: number,
  graduated: boolean
): Promise<void> {
  const msg = [
    `🚨 *AI DEGEN CALL — ROBINHOOD CHAIN (pons)* 🚨`, ``,
    `*Token:* $${c.ticker}`,
    `*Address:* \`${c.tokenAddress}\``,
    `*Market Cap:* $${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `*Liquidity:* $${liquidityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `*Score:* ${score}/100`,
    `*Graduation:* ${(graduationProgress * 100).toFixed(0)}%${graduated ? ' ✅' : ''}`, ``,
    `⚙️ Auto-buy isn't wired up on this chain yet — alert only for now.`, ``,
    `📱 [View on pons](https://ponsfamily.com/launchpad)`,
  ].join('\n');

  try {
    await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    console.log(`✅ pons alert sent: ${c.ticker} — score ${score}/100`);
  } catch (e: any) {
    console.log(`⚠️ Failed to send pons alert: ${e.message}`);
  }
}

export async function runPonsScan(
  bot: { telegram: { sendMessage: (chatId: string, text: string, extra?: any) => Promise<any> } },
  chatId: string
): Promise<void> {
  // 1. Move anything newly detected onto the aging queue
  const fresh = [...ponsTokenQueue];
  ponsTokenQueue.length = 0;
  for (const c of fresh) {
    if (ponsSeenTokens.has(c.tokenAddress)) continue;
    pendingQueue.push({ ...c, firstSeenAt: Date.now() });
  }

  // 2. Walk the aging queue — only evaluate tokens old enough, drop stale ones
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    const p = pendingQueue[i];
    const age = Date.now() - p.firstSeenAt;

    if (age > PENDING_MAX_AGE_MS) {
      pendingQueue.splice(i, 1);
      ponsSeenTokens.add(p.tokenAddress);
      continue;
    }
    if (age < MIN_AGE_MS) continue; // still too fresh — check again next cycle

    const snapshot = await getPonsTokenSnapshot(p.tokenAddress);
    if (!snapshot || snapshot.marketCapUsd <= 0) continue; // no liquidity yet or already rugged — keep trying until max age

    const ethUsd = await getEthUsd();
    const mcap = snapshot.marketCapUsd;
    const liquidityUsd = snapshot.liquidityWeth * ethUsd;

    if (mcap < 3000 || mcap > 80000) continue;
    if (liquidityUsd < 2500) continue;
    if (snapshot.graduationProgress < 0.08) continue;

    const ratio = mcap > 0 ? liquidityUsd / mcap : 0;
    let score = 0;
    if (ratio >= 0.30) score += 40;
    else if (ratio >= 0.20) score += 30;
    else if (ratio >= 0.10) score += 20;
    else if (ratio >= 0.05) score += 10;
    if (mcap >= 3000 && mcap <= 40000) score += 25;
    if (liquidityUsd >= 10000) score += 20;
    else if (liquidityUsd >= 5000) score += 12;
    else if (liquidityUsd >= 2000) score += 6;
    score = Math.min(100, Math.max(0, score));

    if (score < 70) continue;

    const enriched = await getDexScreenerEnrichment(p.tokenAddress);
    if (!enriched) continue; // keep waiting

    pendingQueue.splice(i, 1);
    ponsSeenTokens.add(p.tokenAddress);
    await sendPonsAlert(bot, chatId, p, mcap, liquidityUsd, score, snapshot.graduationProgress, snapshot.graduated);
  }
}
