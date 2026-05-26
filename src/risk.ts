import { TokenSignal } from './types';

export class CapitalRiskEngine {
  private MAX_SOL_ALLOCATION_PER_TRADE = 0.001;
  private MAX_PORTFOLIO_EXPOSURE_SOL = 5.0;
  private GLOBAL_KILL_SWITCH = false;

  public async validateExecutionRisk(signal: TokenSignal): Promise<{ allow: boolean; sizeSol: number; reason?: string }> {
    if (this.GLOBAL_KILL_SWITCH) return { allow: false, sizeSol: 0, reason: 'GLOBAL_RISK_KILL_SWITCH_ACTIVE' };
    if (signal.marketCapUsd < 1000) return { allow: false, sizeSol: 0, reason: 'MCAP_BELOW_1K_LIMIT' };
    if (signal.marketCapUsd > 40000) return { allow: false, sizeSol: 0, reason: 'MCAP_ABOVE_40K_LIMIT' };
    if (signal.alphaScore < 70) return { allow: false, sizeSol: 0, reason: 'ALPHA_SCORE_BELOW_MINIMUM' };
    if (signal.rugProbability > 0.30) return { allow: false, sizeSol: 0, reason: 'RUG_PROBABILITY_TOO_HIGH' };
    if (signal.liquidityUsd < 6000) return { allow: false, sizeSol: 0, reason: 'LIQUIDITY_POOL_UNSAFE' };

        // Double the allocation for A+ setups, standard size for the rest
    const finalSize = (signal.alphaScore > 85 && signal.rugProbability < 0.15)
      ? this.MAX_SOL_ALLOCATION_PER_TRADE * 2 
      : this.MAX_SOL_ALLOCATION_PER_TRADE; 


    return { allow: true, sizeSol: finalSize };
  }
}
