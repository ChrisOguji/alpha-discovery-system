// REPLACE YOUR EXISTING executeJupiterSwap WITH THIS:
async function executeJupiterSwap(outputMint: string, lamports: number): Promise<any> {
  if (!fundingWallet) return null;
  
  // Use a professional public RPC instead of default if possible
  const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  
  // Jupiter endpoints with fallback
  const endpoints = ['https://quote-api.jup.ag/v6', 'https://api.jup.ag/v6'];
  
  for (let i = 0; i < endpoints.length; i++) {
    try {
      // 1. Fetch Quote
      const quoteRes = await axios.get(`${endpoints[i]}/quote`, {
        params: {
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: outputMint,
          amount: lamports,
          slippageBps: 300, // Increased slippage to 3% to handle high volatility
          onlyDirectRoutes: false // Allow aggregator to find complex routes
        },
        timeout: 10000
      });

      // 2. Fetch Swap Transaction
      const swapRes = await axios.post(`${endpoints[i]}/swap`, {
        quoteResponse: quoteRes.data,
        userPublicKey: fundingWallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 100000 // Add a tip to ensure transaction goes through
      }, { timeout: 10000 });

      // 3. Sign and Execute
      const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
      tx.sign([fundingWallet]);
      
      const sig = await connection.sendTransaction(tx, { skipPreflight: true });
      await connection.confirmTransaction(sig, 'confirmed');
      
      return { txid: sig, priceUsd: parseFloat(quoteRes.data.outAmount) / Math.pow(10, 9) };
      
    } catch (e: any) {
      console.warn(`⚠️ Swap attempt ${i+1} failed: ${e.message}`);
      // Wait 15 seconds before trying the next endpoint/route to allow liquidity propagation
      await new Promise(resolve => setTimeout(resolve, 15000));
      continue;
    }
  }
  return null;
}
