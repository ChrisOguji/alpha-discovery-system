import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';
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

// Only escape text strings, never numbers
function escapeText(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function getDynamicMode(score: number): string {
  if (score >= 90) return '⚡ HIGH\\_POTENTIAL\\_RUNNER';
  if (score >= 75) return '⚡ ORGANIC';
  return '⚡ SPECULATIVE';
}

async function scan() {
  console.log("🔍 Scanning DexScreener...");
  try {
    const { data: profiles } = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    console.log(`Found ${profiles.length} profiles. Checking top 5...`);

    for (const p of profiles.slice(0, 5)) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`);
        const pair = data?.pairs?.[0];
        if (!pair) continue;

        const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
        const liquidity = parseFloat(pair.liquidity?.usd || '0');
        const ticker = pair.baseToken.symbol;
        const address = pair.baseToken.address;

        console.log(`Checking ${ticker}: MCAP $${mcap}`);

        const rugProb = mcap < 20000 ? 0.25 : 0.12;
        const alphaScore = Math.min(100, Math.floor((liquidity / mcap) * 300 + 60));

        const signal: TokenSignal = {
          tokenAddress: address,
          ticker,
          alphaScore,
          rugProbability: rugProb,
          liquidityUsd: liquidity,
          marketCapUsd: mcap,
        };

        const [pattern, risk] = await Promise.all([
          intelligence.analyzePattern(signal),
          riskEngine.validateExecutionRisk(signal),
        ]);

        let executionState = '';
        if (risk.allow && pattern.passedPatterns) {
          try {
            const tx = await executor.buildJupiterSwapTransaction(address, risk.sizeSol, 'BUY');
            tx.sign([executor.getWalletKeypair()]);
            const result = await executor.dispatchMevProtectedBundle(tx);
            executionState = result.success
              ? `✅ Auto\\-Buy Executed`
              : `❌ Auto\\-Buy Failed: ${escapeText(result.error || '')}`;
          } catch (execErr: any) {
            executionState = `❌ Execution Blocked: ${escapeText(execErr.message)}`;
          }
        } else {
          const reason = (!risk.allow ? risk.reason : pattern.reason) || '';
          executionState = `❌ Auto\\-Buy Blocked: ${escapeText(reason)}`;
        }

        const walletShort = `${executor.getWalletPublicKey().slice(0, 8)}...${executor.getWalletPublicKey().slice(-4)}`;

        const msg = [
          `🚨🚨 *AUTONOMOUS AI DEGEN CALL* 🚨🚨`,
          ``,
          `*Token:* $${escapeText(ticker)}`,
          `*Address:* \`${address}\``,
          `*Market Cap:* 💰 $${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `*Liquidity:* $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          ``,
          `🤖 *Execution State:*`,
          executionState,
          ``,
          `👾 *Deployer Metrics:*`,
          `• Wallet: \`${walletShort}\``,
          `• Bundled Launch: ${pattern.isBundledLaunch ? '⚠️ Yes' : '✅ No'}`,
          `• Top Holder %: ${pattern.topHolderConcentration}%`,
          `• Liquidity Locked: ${pattern.isLiquidityLocked ? '✅ Yes' : '❌ No'}`,
          ``,
          `📊 *AI Intelligence Matrix:*`,
          `• Alpha Score: 🟢 ${alphaScore}/100`,
          `• Rug Probability: 🛡 ${(rugProb * 100).toFixed(0)}%`,
          `• Dynamic Mode: ${getDynamicMode(alphaScore)}`,
          ``,
          `📱 [Monitor Chart Live](https://dexscreener.com/solana/${address})`,
        ].join('\n');

        await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        console.log(`✅ Rich alert sent for ${ticker}`);

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
}).then(() => {
  console.log(`🤖 Bot Live via Webhook on port ${PORT}`);
  scan();
  setInterval(scan, 60000);
}).catch((err) => {
  console.error("Fatal Launch Error:", err);
  process.exit(1);
});

bot.command('test', (ctx) => ctx.reply('✅ Bot is online and all engines loaded.'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
