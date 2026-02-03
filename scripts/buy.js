// scripts/buy.js
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { request, chromium } from 'playwright';

// ===== ENV =====
const FRAGMENT_BASE  = process.env.FRAGMENT_BASE;                 // https://fragment.com
const LOG_DIR        = process.env.LOG_DIR || './logs';
const STORAGE_STATE  = process.env.STORAGE_STATE || '';           // ./storage.json (рекомендуется)
const PW_PROFILE_DIR = process.env.PW_PROFILE_DIR || '';          // альтернатива: взять куки из профиля
const PENDING_PATH   = process.env.PENDING_PATH || path.join(LOG_DIR, 'pending-tx.json'); // <-- ВАЖНО

function must(v, name){ if(!v) throw new Error(`Missing env ${name}`); return v; }
const BASE    = new URL(must(FRAGMENT_BASE, 'FRAGMENT_BASE'));
const ORIGIN  = BASE.origin;
const BUY_URL = new URL('/stars/buy', BASE).toString();
const API_URL = new URL('/api', BASE).toString();

// ===== ARGS =====
const rawRecipient = process.argv[2];
const amount       = Number(process.argv[3]);
if (!rawRecipient || Number.isNaN(amount) || amount <= 0) {
  console.error('Usage: node buy.js <recipient|@username> <amount>');
  process.exit(1);
}
const inputRecipient = rawRecipient.startsWith('@') ? rawRecipient : `@${rawRecipient}`;

// ===== FS / LOG =====
await fs.mkdir(LOG_DIR, { recursive: true });
const runId      = Date.now();
const runLogFile = path.join(LOG_DIR, `run-${runId}.log`);
const now = () => new Date().toISOString();
const log = async (...a)=>{ const s=`[${now()}] ${a.join(' ')}\n`; process.stdout.write(s); await fs.writeFile(runLogFile, s, {flag:'a'}); };

// запись JSON с гарантией каталога
const saveJson = async (f,d)=>{
  await fs.mkdir(path.dirname(f), { recursive: true });
  const t=f+'.tmp';
  await fs.writeFile(t, JSON.stringify(d,null,2),'utf8');
  await fs.rename(t,f);
};

// единая точка записи pending
const writePending = async (state, extra={})=>{
  const payload = { at: now(), state, recipient: inputRecipient, amount, ...extra };
  await saveJson(PENDING_PATH, payload); // <-- пишем в PENDING_PATH
  await log('pending →', state, JSON.stringify({ target: PENDING_PATH, ...extra }).slice(0, 300));
};

// ===== STORAGE =====
async function loadStorageState() {
  if (STORAGE_STATE) {
    await log('Using STORAGE_STATE file', STORAGE_STATE);
    return JSON.parse(await fs.readFile(STORAGE_STATE, 'utf8'));
  }
  if (!PW_PROFILE_DIR) throw new Error('Either STORAGE_STATE or PW_PROFILE_DIR must be set');
  await log('Export storageState from profile →', PW_PROFILE_DIR);
  const ctx = await chromium.launchPersistentContext(PW_PROFILE_DIR, { headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

// ===== HTTP =====
async function newHttpCtx(storageState) {
  return await request.newContext({
    baseURL: ORIGIN,
    storageState,
    extraHTTPHeaders: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    },
  });
}
const get = (ctx, url, opts={}) => ctx.get(url, opts);

async function postApi(ctx, hash, method, data) {
  const u = new URL(API_URL);
  if (hash) u.searchParams.set('hash', hash);
  const form = new URLSearchParams();
  form.set('method', method);
  for (const [k,v] of Object.entries(data||{})) form.set(k, String(v ?? ''));
  const res = await ctx.post(u.toString(), {
    headers: {
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'origin': ORIGIN,
      'referer': BUY_URL,
    },
    data: form.toString(),
  });
  if (!res.ok()) {
    const txt = await res.text();
    await log(`API ${method} → HTTP ${res.status()} ${res.statusText()}: ${txt.slice(0,200)}`);
  }
  return await res.json().catch(()=> ({}));
}

// выцепляем hash из HTML/скриптов
async function discoverApiHash(ctx) {
  await log('GET', BUY_URL);
  const pageRes = await get(ctx, BUY_URL);
  const html = await pageRes.text();

  let m = html.match(/\/api\?hash=([a-f0-9]{8,})/i);
  if (m) return m[1];

  const scriptSrcs = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/gi)).map(x=>x[1]);
  const candidates = scriptSrcs
    .filter(s => s.endsWith('.js') && (s.startsWith('/') || s.startsWith('./')))
    .slice(0, 12);

  for (const src of candidates) {
    const url = new URL(src, ORIGIN).toString();
    await log('scan', url);
    const r = await get(ctx, url);
    const body = await r.text();
    const mm = body.match(/\/api\?hash=([a-f0-9]{8,})/i);
    if (mm) return mm[1];
  }
  return null;
}

// нормализация получателя на основе ответа searchStarsRecipient
function extractRecipientFromSearch(search, fallback) {
  const found = search?.found || search?.data?.found;
  if (found && typeof found.recipient === 'string' && found.recipient.trim()) {
    return { recipient: found.recipient.trim(), src: 'found.recipient' }; // opaque id
  }
  const list = (search?.results || search?.data?.results || []);
  const r0 = list[0];
  if (r0) {
    const picked = (r0.recipient || r0.id || r0.username || r0.user || fallback).toString().trim();
    return { recipient: picked, src: 'results[0]' };
  }
  return { recipient: fallback, src: 'input' };
}

// извлекаем ID заявки из init (поддержка req_id)
function pickRequestId(init) {
  return (
    init?.id ||
    init?.data?.id ||
    init?.result?.id ||
    init?.req_id ||
    init?.data?.req_id ||
    init?.result?.req_id ||
    null
  );
}

// ===== MAIN =====
const INIT_MAX_RETRIES = 3;
const INIT_RETRY_DELAY_MS = 2000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Классификация ошибок
function classifyError(error, init) {
  const msg = String(error?.message || error || '').toLowerCase();
  const initErr = String(init?.error || '').toLowerCase();
  
  if (msg.includes('access denied') || msg.includes('access')) return 'auth_error';
  if (initErr.includes('price was changed') || msg.includes('price')) return 'price_changed';
  if (msg.includes('hash not found') || msg.includes('api hash')) return 'auth_error';
  return 'unknown';
}

(async()=>{
  let http = null;
  try{
    await log('ORIGIN =', ORIGIN);
    await log('BUY_URL =', BUY_URL);

    const storageState = await loadStorageState();
    http = await newHttpCtx(storageState);

    const hash = await discoverApiHash(http);
    if (!hash) {
      await writePending('error', { message: 'api hash not found', errorType: 'auth_error' });
      throw new Error('Cannot discover API hash');
    }
    await log('API hash =', hash);

    // 1) search → корректный recipient для init*
    await writePending('searching', { hash });
    const search = await postApi(http, hash, 'searchStarsRecipient', { query: inputRecipient, quantity: '' });
    await log('search →', JSON.stringify(search).slice(0,300));

    const { recipient: apiRecipient, src: recipientSrc } = extractRecipientFromSearch(search, inputRecipient);
    await log('using recipient =', apiRecipient, 'src =', recipientSrc);

    // 2) initBuyStarsRequest с РЕТРАЯМИ для "Price was changed"
    await writePending('init', { recipient: apiRecipient, src: recipientSrc });
    
    let init = null;
    let lastInitError = null;
    
    for (let attempt = 1; attempt <= INIT_MAX_RETRIES; attempt++) {
      init = await postApi(http, hash, 'initBuyStarsRequest', { recipient: apiRecipient, quantity: amount });
      await log('init response →', JSON.stringify(init).slice(0, 500));
      
      const accessErr = init?.error || init?.message;
      
      // Проверка на Access denied - не ретраить
      if (accessErr && String(accessErr).toLowerCase().includes('access')) {
        await writePending('error', { message: 'Access denied: login cookies missing or expired', errorType: 'auth_error' });
        throw new Error('Access denied from Fragment API (check STORAGE_STATE/PW_PROFILE_DIR session).');
      }
      
      // Проверка на "Price was changed" - ретраить
      if (accessErr && String(accessErr).toLowerCase().includes('price')) {
        lastInitError = accessErr;
        await log(`[RETRY] initBuyStarsRequest attempt ${attempt}/${INIT_MAX_RETRIES}: ${accessErr}`);
        if (attempt < INIT_MAX_RETRIES) {
          await sleep(INIT_RETRY_DELAY_MS);
          continue;
        }
      }
      
      // Проверка на успешный результат
      const reqId = pickRequestId(init);
      if (reqId) {
        lastInitError = null;
        break; // успех
      }
      
      // Нет reqId - возможно ошибка, ретраим
      lastInitError = init?.error || 'no request id';
      await log(`[RETRY] initBuyStarsRequest attempt ${attempt}/${INIT_MAX_RETRIES}: no id, init = ${JSON.stringify(init).slice(0,200)}`);
      if (attempt < INIT_MAX_RETRIES) {
        await sleep(INIT_RETRY_DELAY_MS);
      }
    }
    
    const reqId = pickRequestId(init);
    if (!reqId) {
      const errorType = classifyError(lastInitError, init);
      await writePending('error', { message: `initBuyStarsRequest: no id after ${INIT_MAX_RETRIES} attempts`, errorType, init });
      throw new Error(`initBuyStarsRequest failed: no id (${lastInitError})`);
    }
    await log('request id =', reqId);

    // 3) getBuyStarsLink → получаем transaction для нашего кошелька
    await writePending('link', { id: reqId });
    const link = await postApi(http, hash, 'getBuyStarsLink', {
      transaction: 1,
      id: reqId,         // основной путь
      req_id: reqId,     // на всякий случай (иногда ждут именно это имя)
      show_sender: 0
    });
    await log('link →', JSON.stringify(link).slice(0,300));

    const tx = link?.transaction || link?.data?.transaction;
    if (!tx) {
      await writePending('error', { message: 'getBuyStarsLink: no transaction', errorType: 'unknown', link });
      throw new Error('getBuyStarsLink failed: no transaction');
    }

    await writePending('ready', {
      source: 'api_direct',
      recipient: apiRecipient,
      amount,
      hash,
      transaction: tx
    });

  } catch (e){
    await log('ERROR:', e?.message || String(e));
    const errorType = classifyError(e);
    try { await writePending('error', { message: e?.message || String(e), errorType }); } catch {}
    process.exitCode = 1;
  } finally {
    if (http) try { await http.dispose(); } catch {}
  }
})();

