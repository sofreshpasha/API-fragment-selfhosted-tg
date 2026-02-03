
// scripts/peek-cookies.js
import 'dotenv/config';
import { chromium } from 'playwright';

const dir = process.env.PW_PROFILE_DIR;
const ctx = await chromium.launchPersistentContext(dir, { headless: true });
const state = await ctx.storageState(); await ctx.close();

const cookies = (state.cookies || []).filter(c => /(^|\.)fragment\.com$/.test(c.domain));
console.log('PW_PROFILE_DIR =', dir);
console.log('Cookies for fragment.com:', cookies.map(c => `${c.name}@${c.domain}`));
console.log('Total:', cookies.length);
