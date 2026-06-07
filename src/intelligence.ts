import axios from 'axios';
import { TokenSignal, PatternMetrics } from './types';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

// Real Solana burn/lock addresses
const BURN_ADDRESSES = [
  '1nc1nerator11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
];

export class OnChainPatternRecognition {

  // ── Real holder data from Helius ──
  private async getTokenHolders(mint: string): Promise<{ count: number; topConcentration: number }> {
    try {
      const res = await axios.post(HELIUS_RPC, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [mint]
      }, { timeout: 5000 });

      const accounts = res.data?.result?.value || [];
      if (accounts.length === 0) return { count: 0, topConcentration: 1 };

      const totalSupply = accounts.reduce((sum: number, a: any) =>
        sum + parseFloat(a.uiAmount || 0), 0);
      const top5 = accounts.slice(0, 5).reduce((sum: number, a: any) =>
        sum + parseFloat(a.uiAmount || 0), 0);
      const topConcentration = totalSupply > 0 ? top5 / totalSupply : 1;

      return { count: accounts.length, topConcentration };
    } catch {
      return { count: 0, topConcentration: 1 };
    }
  }

  // ── Real deployer history ──
  private async getDeployerHistory(deployerAddress: string): Promise<{ rugCount: number; totalLaunches: number }> {
    try {
      const res = await axios.get(`${HELIUS_API}/addresses/${deployerAddress}/transactions`, {
        params: { 'api-key': HELIUS_API_KEY, limit: 50 },
        timeout: 5000
      });

      const txs = res.data || [];
      let rugCount = 0;
      let totalLaunches = 0;

      for (const tx of txs) {
        if (tx.type === 'CREATE' || tx.description?.includes('created token')) {
          totalLaunches++;
          if (tx.tokenTransfers?.length === 0) rugCount++;
        }
      }

      return { rugCount, totalLaunches };
    } catch {
      return { rugCount: 0, totalLaunches: 0 };
    }
  }

  // ── Real bundled launch detection ──
  private async detectBundledLaunch(mint: string): Promise<boolean> {
    try {
      const res = await axios.get(`${HELIUS_API}/addresses/${mint}/transactions`, {
        params: { 'api-key': HELIUS_API_KEY, limit: 20 },
        timeout: 5000
      });

      const txs = res.data || [];
      if (txs.length < 3) return false;

      const slotMap: Record<number, number> = {};
      for (const tx of txs) {
        if (tx.slot) slotMap[tx.slot] = (slotMap[tx.slot] || 0) + 1;
      }

      return Math.max(...Object.values(slotMap)) >= 3;
    } catch {
      return false;
    }
  }

  // ── Real liquidity lock check ──
  private async checkLiquidityLocked(mint: string): Promise<boolean> {
    try {
      const res = await axios.post(HELIUS_RPC, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [mint]
      }, { timeout: 5000 });

      const accounts = res.data?.result?.value || [];
      return accounts.some((a: any) =>
        BURN_ADDRESSES.some(burn => a.address === burn)
      );
    } catch {
      return false;
    }
  }

  // ── Real wash trading detection ──
  private async detectWashTrading(mint: string): Promise<boolean> {
    try {
      const res = await axios.get(`${HELIUS_API}/addresses/${mint}/transactions`, {
        params: { 'api-key': HELIUS_API_KEY, limit: 30 },
        timeout: 5000
      });

      const txs = res.data || [];
      const walletActivity: Record<string, { buys: number; sells: number }> = {};

      for (const tx of txs) {
        const wallet = tx.feePayer;
        if (!wallet) continue;
        if (!walletActivity[wallet]) walletActivity[wallet] = { buys: 0, sells: 0 };

        for (const t of (tx.tokenTransfers || [])) {
          if (t.mint === mint) {
            if (t.toUserAccount === wallet) walletActivity[wallet].buys++;
            if (t.fromUserAccount === wallet) walletActivity[wallet].sells++;
          }
        }
      }

      const washWallets = Object.values(walletActivity).filter(
        w => w.buys >= 2 && w.sells >= 2
      );
      return washWallets.length >= 2;
    } catch {
      return false;
    }
  }

  // ── Smart money detection WITHOUT nested calls ──
  private async detectSmartMoneyEntry(mint: string): Promise<boolean> {
    try {
      const res = await axios.get(`${HELIUS_API}/addresses/${mint}/transactions`, {
        params: { 'api-key': HELIUS_API_KEY, limit: 20 },
        timeout: 5000
      });

      const txs = res.data || [];
      const uniqueWallets = new Set<string>();
      let highValueTxCount = 0;

      for (const tx of txs) {
        if (tx.feePayer) uniqueWallets.add(tx.feePayer);
        // High value tx = native transfer > 0.5 SOL = serious buyer
        const nativeTransfers = tx.nativeTransfers || [];
        for (const t of nativeTransfers) {
          if (t.amount > 500000000) highValueTxCount++; // 0.5 SOL in lamports
        }
      }

      // Smart money present if 2+ high value buys from different wallets
      return highValueTxCount >= 2 && uniqueWallets.size >= 5;
    } catch {
      return false;
    }
  }

  // ── Real buyer velocity ──
  private async getBuyerVelocity(mint: string): Promise<{ uniqueBuyers: number; velocity: 'HIGH' | 'MEDIUM' | 'LOW' }> {
    try {
      const res = await axios.get(`${HELIUS_API}/addresses/${mint}/transactions`, {
        params: { 'api-key': HELIUS_API_KEY, limit: 50 },
        timeout: 5000
      });

      const txs = res.data || [];
      const now = Date.now() / 1000;
      const buyers = new Set<string>();

      for (const tx of txs) {
        if (now - tx.timestamp < 3600 && tx.type === 'SWAP' && tx.feePayer) {
          buyers.add(tx.feePayer);
        }
      }

      const uniqueBuyers = buyers.size;
      const velocity = uniqueBuyers >= 20 ? 'HIGH' : uniqueBuyers >= 8 ? 'MEDIUM' : 'LOW';
      return { uniqueBuyers, velocity };
    } catch {
      return { uniqueBuyers: 0, velocity: 'LOW' };
    }
  }

  // ── Real pump.fun detection ──
  private async isPumpFunToken(mint: string): Promise<boolean> {
  try {
    // ✅ All pump.fun token addresses end in 'pump'
    if (mint.endsWith('pump')) return true;

    // Fallback: check Helius transactions for pump.fun program
    const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const res = await axios.get(`${HELIUS_API}/addresses/${mint}/transactions`, {
      params: { 'api-key': HELIUS_API_KEY, limit: 5 },
      timeout: 5000
    });

    const txs = res.data || [];
    return txs.some((tx: any) =>
      (tx.accountData || []).some((a: any) => a.account === PUMP_FUN_PROGRAM) ||
      tx.source?.toLowerCase() === 'pump_fun' ||
      tx.description?.toLowerCase().includes('pump.fun')
    );
  } catch {
    // If Helius fails, fall back to address check
    return mint.endsWith('pump');
  }
}

  // ── MAIN ANALYSIS ──
  // ── FIX 3: Accept isNew flag to skip LOW_BUYER_VELOCITY gate for brand new tokens ──
  public async analyzePattern(signal: TokenSignal, creatorAddress?: string, isNew = false): Promise<PatternMetrics> {
    try {
      console.log(`🧠 Analysing ${signal.ticker}...`);

      const [
        holderData,
        bundled,
        liquidityLocked,
        washTrading,
        smartMoney,
        buyerVelocity,
        isPump,
        deployerHistory
      ] = await Promise.all([
        this.getTokenHolders(signal.tokenAddress),
        this.detectBundledLaunch(signal.tokenAddress),
        this.checkLiquidityLocked(signal.tokenAddress),
        this.detectWashTrading(signal.tokenAddress),
        this.detectSmartMoneyEntry(signal.tokenAddress),
        this.getBuyerVelocity(signal.tokenAddress),
        this.isPumpFunToken(signal.tokenAddress),
        creatorAddress
          ? this.getDeployerHistory(creatorAddress)
          : Promise.resolve({ rugCount: 0, totalLaunches: 0 })
      ]);

      const topConcentration = holderData.topConcentration;
      const concentrationPct = parseFloat((topConcentration * 100).toFixed(2));

      const base: PatternMetrics = {
        isBundledLaunch: bundled,
        devRugHistoryCount: deployerHistory.rugCount,
        topHolderConcentration: concentrationPct,
        isLiquidityLocked: liquidityLocked,
        smartCohortPresence: smartMoney,
        washTradingDetected: washTrading,
        buyerVelocity: buyerVelocity.velocity,
        uniqueBuyers: buyerVelocity.uniqueBuyers,
        isPumpFun: isPump,
        passedPatterns: false,
        reason: ''
      };

      // ── Gates ──
      if (!isPump) return { ...base, reason: 'NOT_PUMPFUN_TOKEN' };
      if (topConcentration > 0.55) return { ...base, reason: 'TOP_HOLDERS_EXCEED_55PCT' };
      if (bundled) return { ...base, reason: 'BUNDLED_LAUNCH_DETECTED' };
      if (washTrading) return { ...base, reason: 'WASH_TRADING_DETECTED' };
      if (deployerHistory.rugCount >= 2) return { ...base, reason: `DEPLOYER_${deployerHistory.rugCount}_RUGS` };
      // ── FIX 3: Skip LOW_BUYER_VELOCITY gate for new tokens — they have no Helius history yet ──
      if (!isNew && buyerVelocity.velocity === 'LOW') return { ...base, reason: 'LOW_BUYER_VELOCITY' };

      // ── Rug probability hard reject — number 1 ──
      if (signal.rugProbability > 0.15) return { ...base, reason: `RUG_PROB_TOO_HIGH_${(signal.rugProbability * 100).toFixed(0)}PCT` };
      
      console.log(`✅ ${signal.ticker} PASSED | Buyers: ${buyerVelocity.uniqueBuyers} | Top5: ${concentrationPct}% | Smart: ${smartMoney}`);
      return { ...base, passedPatterns: true };

    } catch (e) {
      console.error(`Intelligence error for ${signal.ticker}:`, e);
      return {
        isBundledLaunch: false,
        devRugHistoryCount: 0,
        topHolderConcentration: 0,
        isLiquidityLocked: false,
        smartCohortPresence: false,
        washTradingDetected: false,
        buyerVelocity: 'LOW',
        uniqueBuyers: 0,
        isPumpFun: false,
        passedPatterns: false,
        reason: 'PATTERN_ENGINE_EXCEPTION'
      };
    }
  }
}
