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
  private jupiterUrl = process.env.QUICKNODE_JUPITER_URL || 'https://quote-api.jup.ag/v6';
  private wallet: Keypair | null = null;

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
      //         realTokenReserves (u64), realSolReserves (u64),
      //         tokenTotalSupply (u64), complete (bool)
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

  // ✅ Send straight via RPC and wait for real on-chain confirmation before
  // reporting success — no Jito bundle involved, per request to simplify
  // the execution path down to a single straightforward Jupiter/RPC flow.
  public async executeSwap(tx: VersionedTransaction): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
      if (!rpcUrl) return { success: false, error: 'No RPC URL available' };

      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [
          Buffer.from(tx.serialize()).toString('base64'),
          { encoding: "base64", maxRetries: 3, skipPreflight: true }
        ]
      };

      const res = await this.client.post(rpcUrl, payload, { timeout: 8000 });

      if (res.data?.result) {
        const signature = res.data.result;
        console.log(`\ud83d\udcdd Tx signature: ${signature}`);
        console.log(`\ud83d\udd0d Check: https://solscan.io/tx/${signature}`);

        const confirmed = await this.confirmTransaction(signature, rpcUrl);
        if (confirmed) {
          console.log(`\u2705 Tx confirmed on-chain: ${signature}`);
          return { success: true, signature };
        }

        console.log(`\u26a0\ufe0f Tx not confirmed after 50s \u2014 treating as failed: https://solscan.io/tx/${signature}`);
        return { success: false, error: 'Transaction not confirmed on-chain within 50s' };
      }

      return { success: false, error: res.data?.error?.message || 'RPC Rejected' };
    } catch (e: any) {
      const status = e.response?.status;
      const body = e.response?.data;
      console.log(
        `\u26a0\ufe0f Swap send failed${status ? ` (HTTP ${status})` : ''}: ${e.message}${body ? ` \u2014 response: ${JSON.stringify(body)}` : ''}`
      );
      return { success: false, error: 'RPC network failure' };
    }
  }

  // \u2705 Background confirmation \u2014 20 attempts over 50 seconds
  private async confirmTransaction(signature: string, rpcUrl: string): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      try {
        await new Promise(resolve => setTimeout(resolve, 2500));
        const res = await this.client.post(rpcUrl, {
          jsonrpc: "2.0",
          id: 1,
          method: "getSignatureStatuses",
          params: [[signature], { searchTransactionHistory: true }]
        }, { timeout: 5000 });

        const status = res.data?.result?.value?.[0];
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
