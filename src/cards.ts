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
  ];
  drawStatGrid(ctx, stats, 500);

  return canvas.toBuffer('image/png');
}

// ── Card 3: Recap card (daily / weekly / monthly) — hero winner, gainers
// list, AND a losses list. Showing only winners would be misleading —
// this is meant to be an honest performance snapshot. ──
export interface RecapCardParams {
  botName: string;
  periodTitle: string;
  heroTicker: string;
  heroMultiple: number;
  gainers: { ticker: string; multiple: number }[];
  losses: { ticker: string; lossPct: number }[];
  statsLine?: string;
}

export async function renderRecapCard(p: RecapCardParams): Promise<Buffer> {
  const accent = GOLD;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, accent);
  drawHeader(ctx, p.botName, p.periodTitle.toUpperCase(), accent);

  // Hero stat, left
  ctx.font = font(24);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('BIGGEST WINNER', 56, 150);

  ctx.font = font(60);
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText(`$${p.heroTicker}`, 56, 185);

  ctx.font = font(90);
  ctx.fillStyle = accent;
  ctx.fillText(`${p.heroMultiple.toFixed(1)}X`, 56, 250);

  // Gainers list, top right
  const listX = 640;
  let listY = 150;
  ctx.font = font(20);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('TOP GAINERS', listX, listY);
  listY += 40;

  p.gainers.slice(0, 3).forEach((item, i) => {
    ctx.font = font(26);
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.fillText(`${i + 1}. $${item.ticker}`, listX, listY);
    ctx.fillStyle = GREEN;
    ctx.textAlign = 'right';
    ctx.fillText(`${item.multiple.toFixed(1)}x`, WIDTH - 56, listY);
    ctx.textAlign = 'left';
    listY += 42;
  });

  // Losses list, bottom right — same treatment as gainers, no hiding it
  listY += 20;
  ctx.font = font(20);
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('STOP LOSSES', listX, listY);
  listY += 40;

  if (p.losses.length === 0) {
    ctx.font = font(24);
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText('None this period', listX, listY);
  } else {
    p.losses.slice(0, 3).forEach((item, i) => {
      ctx.font = font(26);
      ctx.fillStyle = TEXT_PRIMARY;
      ctx.fillText(`${i + 1}. $${item.ticker}`, listX, listY);
      ctx.fillStyle = RED;
      ctx.textAlign = 'right';
      ctx.fillText(`${item.lossPct.toFixed(1)}%`, WIDTH - 56, listY);
      ctx.textAlign = 'left';
      listY += 42;
    });
  }

  if (p.statsLine) {
    ctx.font = font(24);
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(p.statsLine, 56, HEIGHT - 70);
  }

  return canvas.toBuffer('image/png');
}
