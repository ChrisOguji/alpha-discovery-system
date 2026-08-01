import axios from 'axios';
import {
  VersionedTransaction,
  Keypair,
  SystemProgram,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  AccountMeta
} from '@solana/web3.js';
import bs58 from 'bs58';
import * as https from 'https';

// ── Official Jito tip accounts — used only as a first-attempt private-bundle path;
// every trade still has a regular-RPC fallback that is untouched by this ──
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

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
  private jitoBundleEndpoint = 'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles';
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

  // ── Build a small tip transfer to a random Jito tip account, sharing the swap tx's
  // blockhash so both can land as one atomic bundle ──
  private buildJitoTipTransaction(tipLamports: number, blockhash: string): Transaction {
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );

    const tipTx = new Transaction();
    tipTx.recentBlockhash = blockhash;
    tipTx.feePayer = this.wallet!.publicKey;
    tipTx.add(
      SystemProgram.transfer({
        fromPubkey: this.wallet!.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      })
    );

    tipTx.sign(this.wallet!);
    return tipTx;
  }

  // ✅ Try landing the swap privately via a Jito bundle first — bundles are atomic, so if
  // Jito doesn't accept/land it, nothing executes and nothing is spent, meaning the plain
  // RPC fallback below always sees a fresh, unspent, still-valid signed tx. That fallback
  // is untouched from before this was added — this is a pure first-attempt on top.
  public async executeSwap(tx: VersionedTransaction): Promise<{ success: boolean; signature?: string; error?: string }> {
    const signature = bs58.encode(tx.signatures[0]);

    const jitoResult = await this.trySendViaJitoBundle(tx, signature);
    if (jitoResult) return jitoResult;

    return this.sendViaRpc(tx, signature);
  }

  private async trySendViaJitoBundle(
    tx: VersionedTransaction,
    signature: string
  ): Promise<{ success: boolean; signature?: string; error?: string } | null> {
    try {
      const TIP_LAMPORTS = Math.floor(0.001 * LAMPORTS_PER_SOL);
      const tipTx = this.buildJitoTipTransaction(TIP_LAMPORTS, tx.message.recentBlockhash);

      const tipEncoded = Buffer.from(tipTx.serialize()).toString('base64');
      const swapEncoded = Buffer.from(tx.serialize()).toString('base64');

      const res = await this.client.post(
        this.jitoBundleEndpoint,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          // Jito's sendBundle expects base58 unless the encoding is declared explicitly.
          params: [[tipEncoded, swapEncoded], { encoding: 'base64' }]
        },
        { timeout: 10000 }
      );

      if (res.data?.result) {
        console.log(`📦 Jito bundle sent: ${res.data.result} (tx ${signature})`);
        const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || '';
        this.confirmTransaction(signature, rpcUrl).then(confirmed => {
          if (confirmed) console.log(`✅ Tx confirmed on-chain via Jito bundle: ${signature}`);
          else console.log(`⚠️ Tx not confirmed after 50s — check manually: https://solscan.io/tx/${signature}`);
        });
        return { success: true, signature };
      }

      console.log(`⚠️ Jito rejected, falling back to direct RPC: ${res.data?.error?.message || 'Jito rejected bundle'}`);
      return null;
    } catch (e: any) {
      const status = e.response?.status;
      const body = e.response?.data;
      console.log(
        `⚠️ Jito bundle failed${status ? ` (HTTP ${status})` : ''}, falling back to direct RPC: ` +
        `${e.message}${body ? ` — response: ${JSON.stringify(body)}` : ''}`
      );
      return null;
    }
  }

  // ✅ Send the Jupiter-built swap tx directly via RPC — returns signature immediately,
  // confirms in background. This is the same path used regardless of whether Jito was
  // attempted first, so a Jito outage never changes how a regular trade executes.
  private async sendViaRpc(
    tx: VersionedTransaction,
    signature: string
  ): Promise<{ success: boolean; signature?: string; error?: string }> {
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
        console.log(`📝 Tx signature: ${signature}`);
        console.log(`🔍 Check: https://solscan.io/tx/${signature}`);

        // ✅ Confirm in background — scan continues immediately
        this.confirmTransaction(signature, rpcUrl).then(confirmed => {
          if (confirmed) console.log(`✅ Tx confirmed on-chain: ${signature}`);
          else console.log(`⚠️ Tx not confirmed after 50s — check manually: https://solscan.io/tx/${signature}`);
        });

        return { success: true, signature };
      }

      return { success: false, error: res.data?.error?.message || 'RPC Rejected' };
    } catch (e: any) {
      const status = e.response?.status;
      const body = e.response?.data;
      console.log(
        `⚠️ Swap send failed${status ? ` (HTTP ${status})` : ''}: ${e.message}${body ? ` — response: ${JSON.stringify(body)}` : ''}`
      );
      return { success: false, error: 'RPC network failure' };
    }
  }

  // ✅ Background confirmation — 20 attempts over 50 seconds
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
          console.log(`❌ Tx failed on-chain: ${JSON.stringify(status.err)}`);
          return false;
        }
      } catch {
        // keep polling
      }
    }
    return false;
  }
}