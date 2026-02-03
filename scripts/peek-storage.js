// scripts/peek-storage.js
import 'dotenv/config';
import fs from 'fs/promises';

const p = process.env.STORAGE_STATE || './storage.json';
const state = JSON.parse(await fs.readFile(p, 'utf8'));
const cookies = (state.cookies || []).filter(c => /(^|\.)fragment\.com$/.test(c.domain));
console.log('Storage file:', p);
console.log('Cookies for fragment.com:', cookies.map(c => `${c.name}@${c.domain}`));
console.log('Total:', cookies.length);
