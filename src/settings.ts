import { db } from './db';

export interface BotSettings {
  tradeSizeSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  delayedEntryEnabled: boolean;
  delayedEntryMcap: number;
}

export const DEFAULT_SETTINGS: BotSettings = {
  tradeSizeSol: 0.15,
  takeProfitPct: 50,
  stopLossPct: 35,
  delayedEntryEnabled: false,
  delayedEntryMcap: 15000,
};

export async function saveSetting(chatId: string, key: keyof BotSettings, value: number | boolean): Promise<void> {
  const colMap: Record<keyof BotSettings, string> = {
    tradeSizeSol: 'trade_size_sol',
    takeProfitPct: 'take_profit_pct',
    stopLossPct: 'stop_loss_pct',
    delayedEntryEnabled: 'delayed_entry_enabled',
    delayedEntryMcap: 'delayed_entry_mcap',
  };
  const col = colMap[key];
  await db.query(
    `INSERT INTO bot_settings (chat_id, ${col})
     VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET ${col} = EXCLUDED.${col}, updated_at = NOW()`,
    [chatId, value]
  );
}

export async function loadSettings(chatId: string): Promise<BotSettings> {
  try {
    const res = await db.query(
      'SELECT trade_size_sol, take_profit_pct, stop_loss_pct, delayed_entry_enabled, delayed_entry_mcap FROM bot_settings WHERE chat_id = $1',
      [chatId]
    );
    if (!res.rows.length) return { ...DEFAULT_SETTINGS };
    const r = res.rows[0];
    return {
      tradeSizeSol: Number(r.trade_size_sol) || DEFAULT_SETTINGS.tradeSizeSol,
      takeProfitPct: Number(r.take_profit_pct) || DEFAULT_SETTINGS.takeProfitPct,
      stopLossPct: Number(r.stop_loss_pct) || DEFAULT_SETTINGS.stopLossPct,
      delayedEntryEnabled: r.delayed_entry_enabled ?? DEFAULT_SETTINGS.delayedEntryEnabled,
      delayedEntryMcap: Number(r.delayed_entry_mcap) || DEFAULT_SETTINGS.delayedEntryMcap,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
