import { createCanvas, loadImage, Image, GlobalFonts } from '@napi-rs/canvas';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs';

// ─────────────────────────────────────────────────────────────────────────
// Card image generator for Dengine.
//
// FONT: headless Linux containers (Railway included) often ship with zero
// system fonts — canvas doesn't error on this, it just silently draws no
// text at all, which is why cards were showing as empty colored boxes.
// Fix: bundle a font file directly in the repo so this never depends on
// what the server happens to have installed.
//
// Put a .ttf file at assets/fonts/CardFont.ttf in the repo root (same
// level as src/). Any font works — one bold/semibold weight is enough
// since everything on the card uses this single family.
//
// Emoji are deliberately NOT drawn inside the image itself (same
// reasoning — no color-emoji font on the server). Labels use plain text +
// color instead. Emoji are fine in the Telegram message text/caption,
// just not baked into the PNG.
// ─────────────────────────────────────────────────────────────────────────

const FONT_PATH = path.join(process.cwd(), 'assets', 'fonts', 'CardFont.ttf');
const FONT_FAMILY = 'CardFont';
let fontReady = false;

try {
  if (fs.existsSync(FONT_PATH)) {
    GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
    fontReady = true;
    console.log('✅ Card font registered');
  } else {
    console.log(`⚠️ Card font not found at ${FONT_PATH} — cards will render with blank text until it's added`);
  }
} catch (e: any) {
  console.log(`⚠️ Card font registration failed: ${e.message}`);
}

function font(size: number): string {
  return `${size}px ${FONT_FAMILY}`;
}

const WIDTH = 1200;
const HEIGHT = 675;
const BG = '#0B0E14';
const TEXT_PRIMARY = '#F5F7FA';
const TEXT_MUTED = '#8B94A3';
const GREEN = '#22C55E';
const RED = '#EF4444';
const GOLD = '#F5B93F';
const PURPLE = '#8B5CF6';

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

// ── Duration formatter — used for "time held" on the milestone card ──
function fmtDuration(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const remMins = m % 60;
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

async function tryLoadLogo(url?: string): Promise<Image | null> {
  if (!url) return null;
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 4000 });
    return await loadImage(Buffer.from(res.data));
  } catch {
    return null;
  }
}

function drawBackground(ctx: any, accent: string) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const grad = ctx.createRadialGradient(WIDTH - 100, 80, 0, WIDTH - 100, 80, 500);
  grad.addColorStop(0, accent + '33');
  grad.addColorStop(1, accent + '00');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  roundRect(ctx, 12, 12, WIDTH - 24, HEIGHT - 24, 28);
  ctx.stroke();
}

function drawHeader(ctx: any, botName: string, badgeText: string, badgeColor: string) {
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = font(34);
  ctx.textBaseline = 'top';
  ctx.fillText(botName, 56, 48);

  ctx.font = font(20);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('onchain alpha tracker', 56, 92);

  ctx.font = font(26);
  const padX = 24;
  const badgeW = ctx.measureText(badgeText).width + padX * 2;
  const badgeX = WIDTH - 56 - badgeW;
  roundRect(ctx, badgeX, 44, badgeW, 52, 26);
  ctx.fillStyle = badgeColor;
  ctx.fill();
  ctx.fillStyle = '#0B0E14';
  ctx.textAlign = 'center';
  ctx.fillText(badgeText, badgeX + badgeW / 2, 58);
  ctx.textAlign = 'left';
}

function drawStatGrid(ctx: any, stats: { label: string; value: string }[], y: number) {
  const cols = 2;
  const colWidth = (WIDTH - 112) / cols;
  stats.forEach((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 56 + col * colWidth;
    const rowY = y + row * 90;

    ctx.font = font(20);
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(s.label.toUpperCase(), x, rowY);

    ctx.font = font(32);
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.fillText(s.value, x, rowY + 30);
  });
}

async function drawTokenLogo(ctx: any, logoUrl: string | undefined, ticker: string, cx: number, cy: number, r: number, accent: string) {
  const img = await tryLoadLogo(logoUrl);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  if (img) {
    ctx.clip();
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = accent + '22';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = accent;
    ctx.font = font(Math.floor(r));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((ticker[0] || '?').toUpperCase(), cx, cy + 4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }
  ctx.restore();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

// ── Card 1: Exit card (Take Profit / Stop Loss) ──
export interface ExitCardParams {
  type: 'TP' | 'SL';
  botName: string;
  traderName: string;
  ticker: string;
  investedSol: number;
  investedUsd: number;
  pnlSol: number;
  pnlUsd: number;
  pnlPct: number;
  entryMcap: number;
  exitMcap: number;
  heldMinutes: number;
  logoUrl?: string;
}

export async function renderExitCard(p: ExitCardParams): Promise<Buffer> {
  const isWin = p.type === 'TP';
  const accent = isWin ? GREEN : RED;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, accent);
  drawHeader(ctx, p.botName, isWin ? 'TAKE PROFIT' : 'STOP LOSS', accent);

  await drawTokenLogo(ctx, p.logoUrl, p.ticker, 130, 200, 64, accent);

  ctx.font = font(56);
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText(`$${p.ticker}`, 220, 165);

  ctx.font = font(22);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(`Called by ${p.traderName}`, 220, 225);

  ctx.font = font(110);
  ctx.fillStyle = accent;
  const pctText = `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%`;
  ctx.fillText(pctText, 56, 290);

  const stats = [
    { label: 'Invested', value: `${p.investedSol.toFixed(3)} SOL (${fmtUsd(p.investedUsd)})` },
    { label: isWin ? 'Profit' : 'Loss', value: `${p.pnlSol >= 0 ? '+' : ''}${p.pnlSol.toFixed(3)} SOL (${fmtUsd(p.pnlUsd)})` },
    { label: 'Entry MC', value: fmtUsd(p.entryMcap) },
    { label: 'Exit MC', value: fmtUsd(p.exitMcap) },
  ];
  drawStatGrid(ctx, stats, 460);

  ctx.font = font(20);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(`Held ${p.heldMinutes} minutes`, 56, HEIGHT - 56);

  return canvas.toBuffer('image/png');
}

// ── Card 2: Milestone card ──
export interface MilestoneCardParams {
  botName: string;
  ticker: string;
  multiple: number;
  alertMcap: number;
  peakMcap: number;
  pnlPct: number;
  heldMinutes: number;
  logoUrl?: string;
}

export async function renderMilestoneCard(p: MilestoneCardParams): Promise<Buffer> {
  const accent = p.multiple >= 10 ? GOLD : PURPLE;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, accent);
  drawHeader(ctx, p.botName, 'MILESTONE', accent);

  await drawTokenLogo(ctx, p.logoUrl, p.ticker, 130, 200, 64, accent);

  ctx.font = font(56);
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText(`$${p.ticker}`, 220, 165);

  ctx.font = font(22);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(`${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}% from alert`, 220, 225);

  ctx.font = font(150);
  ctx.fillStyle = accent;
  ctx.fillText(`${p.multiple.toFixed(1)}X`, 56, 300);

  const stats = [
    { label: 'Alert MC', value: fmtUsd(p.alertMcap) },
    { label: 'Peak MC', value: fmtUsd(p.peakMcap) },
    { label: 'Time Held', value: fmtDuration(p.heldMinutes) },
  ];
  drawStatGrid(ctx, stats, 500);

  return canvas.toBuffer('image/png');
}

// ── Card 3: Recap card (daily / weekly / monthly) — hero winner + top 10
// gainers list. ──
export interface RecapCardParams {
  botName: string;
  periodTitle: string;
  dateLine: string;
  heroTicker: string;
  heroMultiple: number;
  gainers: { ticker: string; multiple: number }[];
  statsLine?: string;
}

// ── Lays out every token in `gainers` inside the given box, growing the
// column count and shrinking row height/font as needed so the full list
// fits instead of silently truncating to a fixed top-N. ──
function drawGainersGrid( ctx: any, gainers: { ticker: string; multiple: number }[], x: number, y: number, width: number, height: number ) {
  if (gainers.length === 0) return;

  const MIN_ROW_H = 22;
  const MAX_ROW_H = 38;
  const MAX_COLS = 4;

  let cols = 1;
  let rows = gainers.length;
  let rowH = height / rows;
  while (rowH < MIN_ROW_H && cols < MAX_COLS) {
    cols++;
    rows = Math.ceil(gainers.length / cols);
    rowH = height / rows;
  }
  rowH = Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, rowH));
  const colWidth = width / cols;
  const fontSize = Math.max(14, Math.min(24, Math.floor(rowH - 8)));

  gainers.forEach((item, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const px = x + col * colWidth;
    const py = y + row * rowH;

    ctx.font = font(fontSize);
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.fillText(`${i + 1}. $${item.ticker}`, px, py);
    ctx.fillStyle = GREEN;
    ctx.textAlign = 'right';
    ctx.fillText(`${item.multiple.toFixed(1)}x`, px + colWidth - 16, py);
    ctx.textAlign = 'left';
  });
}

export async function renderRecapCard(p: RecapCardParams): Promise<Buffer> {
  const accent = GOLD;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, accent);
  drawHeader(ctx, p.botName, p.periodTitle.toUpperCase(), accent);

  // Date range, under the header
  ctx.font = font(20);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(p.dateLine, 56, 118);

  // Hero stat, left
  ctx.font = font(22);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('BIGGEST WINNER', 56, 156);

  ctx.font = font(52);
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText(`$${p.heroTicker}`, 56, 188);

  ctx.font = font(76);
  ctx.fillStyle = accent;
  ctx.fillText(`${p.heroMultiple.toFixed(1)}X`, 56, 246);

  // Gainers list — full width below the hero, sized to fit every token
  const listX = 56;
  let listY = 322;
  ctx.font = font(20);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(`TOP GAINERS (${p.gainers.length})`, listX, listY);
  listY += 32;

  const listBottom = HEIGHT - (p.statsLine ? 96 : 56);
  drawGainersGrid(ctx, p.gainers, listX, listY, WIDTH - 112, listBottom - listY);

  if (p.statsLine) {
    ctx.font = font(24);
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(p.statsLine, 56, HEIGHT - 56);
  }

  return canvas.toBuffer('image/png');
}

// ── Card 4: Call result card — shown when someone taps a token from the
// /pnl list. Mirrors the milestone card visually. If the token ever
// crossed +30% at peak, shows the peak multiplier; if it never did,
// shows a stop-loss-styled card instead. This has no invested/profit
// fields (unlike the exit card) since a "call" isn't always a real
// executed position — it's just tracking peak performance. ──
export interface CallResultCardParams {
  botName: string;
  ticker: string;
  alertMcap: number;
  peakMcap: number;
  peakPct: number;
  multiple: number;
  neverPumped: boolean;
  peakMinutes: number;
  logoUrl?: string;
}

export async function renderCallResultCard(p: CallResultCardParams): Promise<Buffer> {
  const accent = p.neverPumped ? RED : (p.multiple >= 10 ? GOLD : PURPLE);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, accent);
  drawHeader(ctx, p.botName, p.neverPumped ? 'STOP LOSS' : 'PEAK PERFORMANCE', accent);

  await drawTokenLogo(ctx, p.logoUrl, p.ticker, 130, 200, 64, accent);

  ctx.font = font(56);
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText(`$${p.ticker}`, 220, 165);

  ctx.font = font(22);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(
    p.neverPumped ? 'Never reached +30%' : `${p.peakPct >= 0 ? '+' : ''}${p.peakPct.toFixed(1)}% at peak`,
    220, 225
  );

  if (p.neverPumped) {
    ctx.font = font(110);
    ctx.fillStyle = accent;
    ctx.fillText(`${p.peakPct >= 0 ? '+' : ''}${p.peakPct.toFixed(1)}%`, 56, 290);
  } else {
    ctx.font = font(150);
    ctx.fillStyle = accent;
    ctx.fillText(`${p.multiple.toFixed(1)}X`, 56, 300);
  }

  const stats = [
    { label: 'Alert MC', value: fmtUsd(p.alertMcap) },
    { label: 'Peak MC', value: fmtUsd(p.peakMcap) },
    { label: 'Time to Peak', value: fmtDuration(p.peakMinutes) },
  ];
  drawStatGrid(ctx, stats, p.neverPumped ? 460 : 500);

  return canvas.toBuffer('image/png');
}
