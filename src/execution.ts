import axios from 'axios';
import { VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as https from 'https';

export class LowLatencyExecutionEngine {
  private jupiterUrl = process.env.QUICKNODE_JUPITER_URL || 'https://quote-api.jup.ag/v6';
  private jitoBundleEndpoint = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
  private wallet: Keypair;

  private client = axios.create({
    httpsAgent: new https.Agent({ family: 4 }),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }
  });

  constructor() {
    const keyString = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_WALLET_PRIVATE_KEY || '';
    if (!keyString) throw new Error("CRITICAL: WALLET_PRIVATE_KEY environment string is missing.");
    this.wallet = Keypair.fromSecretKey(bs58.decode(keyString));
  }

  public getWalletPublicKey(): string {
    return this.wallet.publicKey.toBase58();
  }

  public getWalletKeypair(): Keypair {
    return this.wallet;
  }

  public async buildJupiterSwapTransaction(outputMint: string, solAmount: number, direction: 'BUY' | 'SELL'): Promise<VersionedTransaction> {
    const wsolMint = 'So11111111111111111111111111111111111111112';
    const inputMint = direction === 'BUY' ? wsolMint : outputMint;
    const targetOutputMint = direction === 'BUY' ? outputMint : wsolMint;
    const computedUnits = Math.floor(solAmount * 1_000_000_000);

    const quoteRes = await this.client.get(`${this.jupiterUrl}/quote`, {
      params: {
        inputMint,
        outputMint: targetOutputMint,
        amount: computedUnits,
        slippageBps: 300,
        onlyDirectRoutes: false
      },
      timeout: 8000
    });

    const swapTxRes = await this.client.post(`${this.jupiterUrl}/swap`, {
      quoteResponse: quoteRes.data,
      userPublicKey: this.wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: 60000,
      dynamicSlippage: { "minBps": 50, "maxBps": 1000 },
      prioritizationFeeLamports: "auto"
    }, { timeout: 8000 });

    const swapBuffer = Buffer.from(swapTxRes.data.swapTransaction, 'base64');
    return VersionedTransaction.deserialize(swapBuffer);
  }

  public async dispatchMevProtectedBundle(tx: VersionedTransaction): Promise<{ success: boolean; bundleId?: string; error?: string }> {
    try {
      const serializedTx = bs58.encode(tx.serialize());
      const payload = { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[serializedTx]] };
      const res = await this.client.post(this.jitoBundleEndpoint, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
      if (res.data?.result) {
        const bundleId = res.data.result;
        this.confirmJitoBundle(bundleId).catch(() => {});
        return { success: true, bundleId };
      }
    } catch (e: any) { console.log(`⚠️ Jito failed: ${e.message}`); }
    return this.fallbackToQuickNode(tx.serialize());
  }

  private async confirmJitoBundle(bundleId: string): Promise<boolean> {
    try {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const res = await this.client.post('https://mainnet.block-engine.jito.wtf/api/v1/getBundleStatuses', { jsonrpc: "2.0", id: 1, method: "getBundleStatuses", params: [[bundleId]] }, { timeout: 8000 });
      return res.data?.result?.value?.[0]?.confirmation_status === 'confirmed';
    } catch { return false; }
  }

  private async fallbackToQuickNode(serializedTx: Uint8Array): Promise<{ success: boolean; bundleId?: string; error?: string }> {
    try {
      const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
      if (!rpcUrl) return { success: false, error: 'No RPC URL' };
      const res = await this.client.post(rpcUrl, { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(serializedTx).toString('base64'), { encoding: "base64", maxRetries: 3, skipPreflight: true }] }, { timeout: 8000 });
      if (res.data?.result) return { success: true, bundleId: res.data.result };
      return { success: false, error: res.data?.error?.message };
    } catch (e: any) { return { success: false, error: 'RPC failure' }; }
  }
}
