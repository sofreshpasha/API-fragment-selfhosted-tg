// scripts/open.js
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

['FRAGMENT_BASE','PW_PROFILE_DIR','NAV_TIMEOUT_MS'].forEach(k => {
  if (!process.env[k]) throw new Error(`Missing env: ${k}`);
});

const baseUrl = new URL('/stars/buy', process.env.FRAGMENT_BASE).toString();
const profileDir = path.resolve(process.env.PW_PROFILE_DIR);
const navTimeout = Number(process.env.NAV_TIMEOUT_MS) || 60000;
const storagePath = process.env.STORAGE_STATE || path.resolve('./storage.json');

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--no-sandbox','--disable-dev-shm-usage'],
});
const page = await ctx.newPage();
await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });

console.log('Окно открыто:', baseUrl);
console.log('Профиль:', profileDir);
console.log('1) Войди во Fragment (чтобы в шапке появился твой аккаунт).');
console.log('2) Вернись в терминал и нажми ENTER — сохраню куки в', storagePath, '\n');

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

async function dumpAndExit() {
  const state = await ctx.storageState();
  const cookies = (state.cookies || []).filter(c => /(^|\.)fragment\.com$/.test(c.domain));
  console.log('Cookies for fragment.com:', cookies.map(c => `${c.name}@${c.domain}`));
  await fs.writeFile(storagePath, JSON.stringify(state, null, 2));
  console.log('Saved storage →', storagePath);
  await ctx.close();
  process.exit(0);
}
process.stdin.on('data', async (key) => {
  if (key === '\r' || key === '\n') { try { await dumpAndExit(); } catch(e){ console.error(e); process.exit(1); } }
  if (key === '\u0003') { await ctx.close(); process.exit(0); } // Ctrl+C
});
