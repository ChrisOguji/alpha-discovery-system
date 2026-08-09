import axios from 'axios';
import {
  VersionedTransaction,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  AccountMeta
} from '@solana/web3.js';
import bs58 from 'bs58';
import * as https from 'https';

// ── Submission tuning (env-overridable, safe defaults) ──
// A transient failure on a single RPC used to collapse the whole buy into a
// generic "RPC network failure". The submission path now: (1) fans out across
// every configured endpoint with rotation, and (2) re-sends the IDENTICAL
// signed tx a few times — Solana dedupes by signature so this cannot double
// execute, it only raises the odds of the tx landing when the network drops
// the first send. The swap itself is built and routed by Jupiter upstream;
// this layer only broadcasts it.
const RPC_ENDPOINTS: string[] = [
  process.env.QUICKNODE_RPC_URL,
  process.env.SOLANA_RPC_URL,
  process.env.SOLANA_RPC_URL_BACKUP,
].filter((u): u is string => typeof u === 'string' && u.length > 0);

const MAX_RPC_RETRIES  = parseInt(process.env.MAX_RPC_RETRIES  || '5', 10);
const BLAST_COUNT      = parseInt(process.env.BLAST_COUNT      || '4', 10);
const BLAST_INTERVAL_MS = parseInt(process.env.BLAST_INTERVAL_MS || '2000', 10);
const RPC_SEND_RETRIES = parseInt(process.env.RPC_SEND_RETRIES || '3', 10);

// ── pump.fun program constants ──
const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_GLOBAL = new PublicKey('4wTV81avi27K1Wd4kFgFnntJjKvim8EWEjqjMDMFGFTX');
const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgznyZKFL18NUSjCUNVDeD');
const PUMP_FUN_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bse');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

// ── Discriminators for pump.fun buy/sell instructions ──
const BUY_DISCRIMINATOR  = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

export class LowLatencyExecutionEngine {
  // Default to Jupiter's current lite-api endpoint. The old quote-api.jup.ag/v6
  // has been deprecated and can return quotes that build txs referencing stale
  // routes, which leaders silently reject — producing signatures that never land.
  private jupiterUrl = process.env.QUICKNODE_JUPITER_URL || 'https://lite-api.jup.ag/swap/v1';
  private wallet: Keypair | null = null;

  // ── RPC failover state ──
  private rpcEndpoints: string[] = RPC_ENDPOINTS.length > 0
    ? RPC_ENDPOINTS
    : ['https://api.mainnet-beta.solana.com'];
  private rpcIndex = 0;
  private rpcId = 0;
  // Keep strong refs to fire-and-forget blast/confirm tasks so they aren't GC'd.
  private background: Set<Promise<void>> = new Set();

  // ── Trade protection: abort rather than execute into a thin/manipulated pool ──
  private readonly MAX_PRICE_IMPACT_PCT = 15;

  private client = axios.create({
    httpsAgent: new https.Agent({ family: 4 }),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }
  });

  constructor() {
    const keyString = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_WALLET_PRIVATE_KEY || '';
    if (keyString) {
      try {
        this.wallet = Keypair.fromSecretKey(bs58.decode(keyString));
        console.log(`🔑 Wallet loaded from env: ${this.wallet.publicKey.toBase58().slice(0, 8)}...`);
      } catch {
        console.log('⚠️ Invalid WALLET_PRIVATE_KEY in env — wallet not loaded from env');
      }
    } else {
      console.log('⚠️ No WALLET_PRIVATE_KEY in env — auto-buy disabled until wallet set via /settings');
    }
  }

  public hasWallet(): boolean {
    return this.wallet !== null;
  }

  public setWallet(keypair: Keypair): void {
    this.wallet = keypair;
    console.log(`🔑 Wallet updated: ${keypair.publicKey.toBase58().slice(0, 8)}...`);
  }

  public getWalletPublicKey(): string {
    if (!this.wallet) throw new Error('No wallet loaded');
    return this.wallet.publicKey.toBase58();
  }

  public getWalletKeypair(): Keypair {
    if (!this.wallet) throw new Error('No wallet loaded');
    return this.wallet;
  }

  // ── Derive bonding curve PDA for a pump.fun token ──
  private deriveBondingCurve(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_FUN_PROGRAM_ID
    );
    return pda;
  }

  // ── Derive associated bonding curve token account ──
  private deriveAssociatedBondingCurve(mint: PublicKey, bondingCurve: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        bondingCurve.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        mint.toBuffer()
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return pda;
  }

  // ── Derive user associated token account ──
  private deriveUserTokenAccount(mint: PublicKey, owner: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        owner.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        mint.toBuffer()
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return pda;
  }

  // ── Fetch bonding curve state to get real-time price ──
  private async getBondingCurveState(bondingCurve: PublicKey): Promise<{
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
    realTokenReserves: bigint;
    realSolReserves: bigint;
    complete: boolean;
  } | null> {
    try {
      const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || '';
      const res = await this.client.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [bondingCurve.toBase58(), { encoding: 'base64' }]
      }, { timeout: 5000 });

      const data = res.data?.result?.value?.data?.[0];
      if (!data) return null;

      const buf = Buffer.from(data, 'base64');
      // Skip 8-byte discriminator
      // Layout: virtualTokenReserves (u64), virtualSolReserves (u64),
      // realTokenReserves (u64), realSolReserves (u64),
      // tokenTotalSupply (u64), complete (bool)
      if (buf.length < 49) return null;
      const virtualTokenReserves = buf.readBigUInt64LE(8);
      const virtualSolReserves   = buf.readBigUInt64LE(16);
      const realTokenReserves    = buf.readBigUInt64LE(24);
      const realSolReserves      = buf.readBigUInt64LE(32);
      const complete             = buf.readUInt8(48) === 1;

      return { virtualTokenReserves, virtualSolReserves, realTokenReserves, realSolReserves, complete };
    } catch {
      return null;
    }
  }

  // ── Calculate tokens out for a given SOL input using bonding curve formula ──
  private calcTokensOut(solAmountLamports: bigint, state: {
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
  }): bigint {
    // pump.fun uses constant product: x * y = k
    // tokens_out = (token_reserves * sol_in) / (sol_reserves + sol_in)
    const numerator   = state.virtualTokenReserves * solAmountLamports;
    const denominator = state.virtualSolReserves + solAmountLamports;
    return numerator / denominator;
  }

  // ── Build direct pump.fun buy instruction ──
  private buildPumpBuyInstruction(
    mint: PublicKey,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    userTokenAccount: PublicKey,
    tokenAmount: bigint,
    maxSolLamports: bigint
  ): TransactionInstruction {
    // Instruction data: discriminator (8) + tokenAmount (u64 LE) + maxSolCost (u64 LE)
    const data = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(tokenAmount, 8);
    data.writeBigUInt64LE(maxSolLamports, 16);

    const keys: AccountMeta[] = [
      { pubkey: PUMP_FUN_GLOBAL,              isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT,       isSigner: false, isWritable: true  },
      { pubkey: mint,                         isSigner: false, isWritable: false },
      { pubkey: bondingCurve,                 isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve,       isSigner: false, isWritable: true  },
      { pubkey: userTokenAccount,             isSigner: false, isWritable: true  },
      { pubkey: this.wallet!.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: SYSTEM_PROGRAM_ID,            isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,             isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT,                  isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_EVENT_AUTHORITY,     isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID,          isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({ programId: PUMP_FUN_PROGRAM_ID, keys, data });
  }

  // ── Build direct pump.fun sell instruction ──
  private buildPumpSellInstruction(
    mint: PublicKey,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    userTokenAccount: PublicKey,
    tokenAmount: bigint,
    minSolOutput: bigint
  ): TransactionInstruction {
    // Instruction data: discriminator (8) + tokenAmount (u64 LE) + minSolOutput (u64 LE)
    const data = Buffer.alloc(24);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(tokenAmount, 8);
    data.writeBigUInt64LE(minSolOutput, 16);

    const keys: AccountMeta[] = [
      { pubkey: PUMP_FUN_GLOBAL,              isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT,       isSigner: false, isWritable: true  },
      { pubkey: mint,                         isSigner: false, isWritable: false },
      { pubkey: bondingCurve,                 isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve,       isSigner: false, isWritable: true  },
      { pubkey: userTokenAccount,             isSigner: false, isWritable: true  },
      { pubkey: this.wallet!.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: SYSTEM_PROGRAM_ID,            isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,             isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_EVENT_AUTHORITY,     isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID,          isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({ programId: PUMP_FUN_PROGRAM_ID, keys, data });
  }

  // ── Build pump.fun direct swap transaction (pre-graduation) ──
  public async buildPumpFunSwapTransaction(
    tokenAddress: string,
    solAmount: number,
    direction: 'BUY' | 'SELL'
  ): Promise<VersionedTransaction> {
    const mint = new PublicKey(tokenAddress);
    const bondingCurve = this.deriveBondingCurve(mint);
    const associatedBondingCurve = this.deriveAssociatedBondingCurve(mint, bondingCurve);
    if (!this.wallet) throw new Error('No wallet configured. Use /settings to set your wallet.');
    const userTokenAccount = this.deriveUserTokenAccount(mint, this.wallet.publicKey);

    const solLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));

    // ── Fetch bonding curve state for price calculation ──
    const state = await this.getBondingCurveState(bondingCurve);
    if (!state) throw new Error('Could not fetch bonding curve state');
    if (state.complete) throw new Error('Token already graduated to Raydium — use Jupiter');

    const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || '';
    const blockhashRes = await this.client.post(rpcUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'confirmed' }]
    }, { timeout: 5000 });
    const blockhash = blockhashRes.data?.result?.value?.blockhash;
    if (!blockhash) throw new Error('Could not fetch blockhash');

    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet!.publicKey;

    if (direction === 'BUY') {
      // 25% slippage buffer for fast-moving tokens
      const tokensOut = this.calcTokensOut(solLamports, state);
      const minTokensWithSlippage = (tokensOut * 75n) / 100n;
      const maxSolWithSlippage = (solLamports * 125n) / 100n;

      tx.add(this.buildPumpBuyInstruction(
        mint, bondingCurve, associatedBondingCurve, userTokenAccount,
        minTokensWithSlippage, maxSolWithSlippage
      ));
    } else {
      // For sell: token amount comes in as solAmount param (reused as token units)
      const tokenLamports = BigInt(Math.floor(solAmount * 1_000_000));
      // Minimum SOL out with 25% slippage
      const solOut = (state.virtualSolReserves * tokenLamports) / (state.virtualTokenReserves + tokenLamports);
      const minSolOut = (solOut * 75n) / 100n;

      tx.add(this.buildPumpSellInstruction(
        mint, bondingCurve, associatedBondingCurve, userTokenAccount,
        tokenLamports, minSolOut
      ));
    }

    tx.sign(this.wallet!);

    // ── Convert legacy Transaction to VersionedTransaction for unified dispatch ──
    const serialized = tx.serialize();
    return VersionedTransaction.deserialize(serialized);
  }

  public async buildJupiterSwapTransaction(
    outputMint: string,
    solAmount: number,
    direction: 'BUY' | 'SELL',
    slippageBps: number
  ): Promise<VersionedTransaction> {
    if (!this.wallet) throw new Error('No wallet configured. Use /settings to set your wallet.');
    const wsolMint = 'So11111111111111111111111111111111111111112';
    const inputMint = direction === 'BUY' ? wsolMint : outputMint;
    const targetOutputMint = direction === 'BUY' ? outputMint : wsolMint;
    const computedUnits = Math.floor(solAmount * 1_000_000_000);

    const quoteRes = await this.client.get(`${this.jupiterUrl}/quote`, {
      params: {
        inputMint,
        outputMint: targetOutputMint,
        amount: computedUnits,
        slippageBps,
        onlyDirectRoutes: false,
        dynamicSlippage: true
      },
      timeout: 8000
    });

    // ── Trade protection: refuse to route into a pool so thin the trade itself moves
    // the price past our tolerance — this is the classic setup for a sandwich attack ──
    const priceImpactPct = parseFloat(quoteRes.data?.priceImpactPct || '0') * 100;
    if (priceImpactPct > this.MAX_PRICE_IMPACT_PCT) {
      throw new Error(
        `Price impact too high: ${priceImpactPct.toFixed(2)}% (max ${this.MAX_PRICE_IMPACT_PCT}%) — thin liquidity, aborting trade`
      );
    }

    const swapTxRes = await this.client.post(`${this.jupiterUrl}/swap`, {
      quoteResponse: quoteRes.data,
      userPublicKey: this.wallet!.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 3000000,
          priorityLevel: "veryHigh"
        }
      }
    }, { timeout: 8000 });

    const swapBuffer = Buffer.from(swapTxRes.data.swapTransaction, 'base64');
    return VersionedTransaction.deserialize(swapBuffer);
  }

  // ── Read the wallet's actual held balance + decimals for a token. Needed
  // because Jupiter's quote API wants the raw amount in the token's own
  // decimals, which varies per token — not the fixed 9 decimals SOL uses. ──
  public async getTokenBalance(mintAddress: string): Promise<{ rawAmount: bigint; decimals: number } | null> {
    if (!this.wallet) return null;
    try {
      const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || '';
      const res = await this.client.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          this.wallet.publicKey.toBase58(),
          { mint: mintAddress },
          { encoding: 'jsonParsed' }
        ]
      }, { timeout: 8000 });

      const account = res.data?.result?.value?.[0];
      if (!account) return null;
      const info = account.account?.data?.parsed?.info?.tokenAmount;
      if (!info) return null;
      return { rawAmount: BigInt(info.amount), decimals: info.decimals };
    } catch {
      return null;
    }
  }

  // ── Sell the wallet's full held balance of a token via Jupiter. This is
  // the method TP/SL exits should call — it reads the real on-chain balance
  // first rather than assuming an amount, so it always sells exactly what's
  // actually held, correctly scaled for that token's real decimals. ──
  public async buildJupiterSellTransaction(mint: string, slippageBps: number): Promise<VersionedTransaction> {
    if (!this.wallet) throw new Error('No wallet configured. Use /settings to set your wallet.');

    const balance = await this.getTokenBalance(mint);
    if (!balance || balance.rawAmount === 0n) {
      throw new Error('No token balance found in wallet to sell');
    }

    const wsolMint = 'So11111111111111111111111111111111111111112';

    const quoteRes = await this.client.get(`${this.jupiterUrl}/quote`, {
      params: {
        inputMint: mint,
        outputMint: wsolMint,
        amount: balance.rawAmount.toString(),
        slippageBps,
        onlyDirectRoutes: false,
        dynamicSlippage: true
      },
      timeout: 8000
    });

    // ── Same thin-liquidity protection as the buy side ──
    const priceImpactPct = parseFloat(quoteRes.data?.priceImpactPct || '0') * 100;
    if (priceImpactPct > this.MAX_PRICE_IMPACT_PCT) {
      throw new Error(
        `Price impact too high: ${priceImpactPct.toFixed(2)}% (max ${this.MAX_PRICE_IMPACT_PCT}%) — thin liquidity, aborting sell`
      );
    }

    const swapTxRes = await this.client.post(`${this.jupiterUrl}/swap`, {
      quoteResponse: quoteRes.data,
      userPublicKey: this.wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 3000000,
          priorityLevel: "veryHigh"
        }
      }
    }, { timeout: 8000 });

    const swapBuffer = Buffer.from(swapTxRes.data.swapTransaction, 'base64');
    return VersionedTransaction.deserialize(swapBuffer);
  }

  // ── JSON-RPC call with automatic failover across every configured endpoint.
  // A dead/slow/rate-limited node rotates to the next one and retries with
  // backoff instead of bubbling up as a fatal "RPC network failure". ──
  private async rpc(method: string, params: any[], retries = RPC_SEND_RETRIES): Promise<any> {
    this.rpcId += 1;
    const payload = { jsonrpc: '2.0', id: this.rpcId, method, params };

    let lastErr: any = null;
    for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
      const url = this.rpcEndpoints[this.rpcIndex % this.rpcEndpoints.length];
      try {
        const res = await this.client.post(url, payload, { timeout: 8000 });
        const err = res.data?.error;
        if (err) {
          // Rate limit / node-side failure → rotate and retry.
          const code = err.code;
          if (code === -32005 || code === -32603 || code === 429) {
            this.rotateRpc();
            lastErr = err;
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          // A real program/tx error is not a transport failure — return it.
          return { error: err };
        }
        return { result: res.data?.result };
      } catch (e: any) {
        lastErr = e;
        this.rotateRpc();
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return { error: lastErr };
  }

  private rotateRpc(): void {
    if (this.rpcEndpoints.length > 1) {
      this.rpcIndex = (this.rpcIndex + 1) % this.rpcEndpoints.length;
    }
  }

  private spawn(p: Promise<void>): void {
    this.background.add(p);
    p.finally(() => this.background.delete(p));
  }

  // ── One sendTransaction across the failover RPC pool. ──
  // Preflight is skipped by default for speed. Set DEBUG_PREFLIGHT=true in
  // env to enable it — the RPC will then surface any pre-execution errors
  // (bad instruction, missing account, stale route, etc.) that are otherwise
  // silently swallowed and cause the tx to appear to send but never land.
  private async sendRaw(encodedTx: string): Promise<string | null> {
    const skipPreflight = process.env.DEBUG_PREFLIGHT !== 'true';
    const out = await this.rpc('sendTransaction', [
      encodedTx,
      {
        encoding: 'base64',
        skipPreflight,
        maxRetries: MAX_RPC_RETRIES,
        preflightCommitment: 'processed',
      },
    ]);
    return typeof out.result === 'string' ? out.result : null;
  }

  // ── Re-send the IDENTICAL signed tx BLAST_COUNT times. Solana dedupes by
  // signature, so this can never double-execute the buy — it only raises the
  // odds of landing when the network drops the first send. Halts early once
  // the tx is confirmed. This was the single biggest cause of missed buys. ──
  private async blast(encodedTx: string, signature: string): Promise<void> {
    for (let i = 0; i < BLAST_COUNT; i++) {
      await new Promise(r => setTimeout(r, BLAST_INTERVAL_MS));
      try {
        if (await this.isConfirmed(signature)) return;
        await this.sendRaw(encodedTx);
        console.log(`\ud83d\udd01 blast ${i + 1}/${BLAST_COUNT} ${signature.slice(0, 8)}...`);
      } catch { /* keep blasting */ }
    }
  }

  // ✅ Broadcast the Jupiter-built signed swap directly via RPC with endpoint
  // failover + retry-blast + background confirmation. No Jito bundle — the tx
  // is sent straight to sendTransaction across the endpoint pool, so a single
  // node hiccup no longer aborts the buy. Priority fee (for landing speed)
  // belongs in the Jupiter swap request at build time, not here.
  public async executeSwap(tx: VersionedTransaction): Promise<{ success: boolean; signature?: string; error?: string }> {
    if (this.rpcEndpoints.length === 0) return { success: false, error: 'No RPC URL available' };

    let encoded: string;
    let signature: string;
    try {
      encoded = Buffer.from(tx.serialize()).toString('base64');
      signature = bs58.encode(tx.signatures[0]);
    } catch (e: any) {
      return { success: false, error: `Failed to serialize transaction: ${e.message}` };
    }

    // ── Direct RPC send with failover ──
    const first = await this.sendRaw(encoded);
    if (!first) {
      // The blast may still land it; keep trying in the background but report.
      this.spawn(this.blast(encoded, signature));
      return { success: false, signature, error: 'RPC send failed on all endpoints' };
    }

    console.log(`\ud83d\ude80 Tx dispatched via RPC: ${first}`);
    console.log(`\ud83d\udd0d Check: https://solscan.io/tx/${first}`);

    // ── Retry-blast (background) + confirm ──
    this.spawn(this.blast(encoded, first));
    const confirmed = await this.confirmTransaction(first);
    if (confirmed) {
      console.log(`\u2705 Tx confirmed on-chain: ${first}`);
      return { success: true, signature: first };
    }

    // ── Reconciliation: the confirmation loop timed out at ~50s, but the
    // background blast is still trying. Give it a brief grace window, then
    // do one authoritative status lookup with searchTransactionHistory=true
    // before declaring failure. Prevents false negatives where the tx lands
    // at second 51+ and the bot incorrectly reports "not confirmed" while
    // real funds have moved on-chain. ──
    await new Promise(r => setTimeout(r, 5000));
    const finalStatus = await this.finalStatusCheck(first);
    if (finalStatus === 'confirmed') {
      console.log(`\u2705 Tx confirmed on-chain (late land): ${first}`);
      return { success: true, signature: first };
    }
    if (finalStatus === 'failed') {
      console.log(`\u274c Tx failed on-chain: https://solscan.io/tx/${first}`);
      return { success: false, signature: first, error: 'Transaction failed on-chain' };
    }

    console.log(`\u26a0\ufe0f Tx not confirmed in time \u2014 treating as failed: https://solscan.io/tx/${first}`);
    return { success: false, signature: first, error: 'Transaction not confirmed on-chain within timeout' };
  }

  // ── Authoritative "did this tx land?" check using signature history.
  // Returns 'confirmed' if landed successfully, 'failed' if landed with
  // an on-chain error, or 'unknown' if the tx is genuinely not on chain
  // (dropped by leaders, silently rejected, or still pending). ──
  private async finalStatusCheck(signature: string): Promise<'confirmed' | 'failed' | 'unknown'> {
    try {
      const out = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const status = out.result?.value?.[0];
      if (!status) return 'unknown';
      if (status.err) return 'failed';
      if (status.confirmationStatus === 'confirmed' ||
          status.confirmationStatus === 'finalized') {
        return 'confirmed';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ── Single status check across the failover RPC pool. ──
  private async isConfirmed(signature: string): Promise<boolean> {
    const out = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
    const status = out.result?.value?.[0];
    if (!status) return false;
    if (status.err) return false;
    return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
  }

  // ✅ Confirmation polling — 20 attempts over ~50 seconds, failover-aware.
  private async confirmTransaction(signature: string): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      try {
        const out = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
        const status = out.result?.value?.[0];
        if (status?.confirmationStatus === 'confirmed' ||
            status?.confirmationStatus === 'finalized') {
          return true;
        }
        if (status?.err) {
          console.log(`\u274c Tx failed on-chain: ${JSON.stringify(status.err)}`);
          return false;
        }
      } catch {
        // keep polling
      }
    }
    return false;
  }
}
