// scripts/fragment-session.js
// Модуль для проверки валидности сессии Fragment
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { request, chromium } from 'playwright';

const FRAGMENT_BASE = process.env.FRAGMENT_BASE || 'https://fragment.com';
const STORAGE_STATE = process.env.STORAGE_STATE || '';
const PW_PROFILE_DIR = process.env.PW_PROFILE_DIR || '';

const ORIGIN = new URL(FRAGMENT_BASE).origin;
const BUY_URL = new URL('/stars/buy', FRAGMENT_BASE).toString();

// Кэш результата проверки
let sessionCache = { valid: null, checkedAt: 0, error: null };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

/**
 * Загружает storageState из файла или профиля
 */
async function loadStorageState() {
  if (STORAGE_STATE) {
    try {
      return JSON.parse(await fs.readFile(STORAGE_STATE, 'utf8'));
    } catch (e) {
      throw new Error(`Cannot read STORAGE_STATE: ${e.message}`);
    }
  }
  if (!PW_PROFILE_DIR) {
    throw new Error('Either STORAGE_STATE or PW_PROFILE_DIR must be set');
  }
  const ctx = await chromium.launchPersistentContext(PW_PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

/**
 * Создаёт HTTP контекст с cookies
 */
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

/**
 * Пытается найти API hash в HTML страницы.
 * Если hash найден — сессия валидна
 */
async function discoverApiHash(ctx) {
  const pageRes = await ctx.get(BUY_URL);
  const html = await pageRes.text();

  // Проверяем наличие API hash
  let m = html.match(/\/api\?hash=([a-f0-9]{8,})/i);
  if (m) return m[1];

  // Ищем в подключённых скриптах
  const scriptSrcs = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/gi)).map(x => x[1]);
  const candidates = scriptSrcs
    .filter(s => s.endsWith('.js') && (s.startsWith('/') || s.startsWith('./')))
    .slice(0, 5);

  for (const src of candidates) {
    const url = new URL(src, ORIGIN).toString();
    const r = await ctx.get(url);
    const body = await r.text();
    const mm = body.match(/\/api\?hash=([a-f0-9]{8,})/i);
    if (mm) return mm[1];
  }
  return null;
}

/**
 * Проверяет валидность сессии Fragment
 * @param {boolean} forceCheck - игнорировать кэш
 * @returns {Promise<{valid: boolean, hash?: string, error?: string, cached: boolean}>}
 */
export async function checkSession(forceCheck = false) {
  // Проверяем кэш
  if (!forceCheck && sessionCache.checkedAt > Date.now() - CACHE_TTL_MS) {
    return {
      valid: sessionCache.valid,
      error: sessionCache.error,
      cached: true,
      checkedAt: sessionCache.checkedAt
    };
  }

  let http = null;
  try {
    const storageState = await loadStorageState();
    http = await newHttpCtx(storageState);
    
    const hash = await discoverApiHash(http);
    const valid = !!hash;
    
    // Обновляем кэш
    sessionCache = {
      valid,
      checkedAt: Date.now(),
      error: valid ? null : 'API hash not found - session may be expired'
    };

    return { valid, hash, cached: false, checkedAt: sessionCache.checkedAt };
  } catch (e) {
    sessionCache = {
      valid: false,
      checkedAt: Date.now(),
      error: e.message
    };
    return { valid: false, error: e.message, cached: false, checkedAt: sessionCache.checkedAt };
  } finally {
    if (http) try { await http.dispose(); } catch {}
  }
}

/**
 * Быстрая проверка (использует кэш)
 */
export async function isSessionValid() {
  const result = await checkSession(false);
  return result.valid;
}

/**
 * Инвалидирует кэш (вызывать после реавторизации)
 */
export function invalidateCache() {
  sessionCache = { valid: null, checkedAt: 0, error: null };
}

/**
 * Получает информацию о сессии
 */
export function getSessionInfo() {
  return {
    valid: sessionCache.valid,
    error: sessionCache.error,
    lastCheck: sessionCache.checkedAt ? new Date(sessionCache.checkedAt).toISOString() : null,
    cacheAge: sessionCache.checkedAt ? Math.floor((Date.now() - sessionCache.checkedAt) / 1000) : null
  };
}

// CLI режим - если запущен напрямую
if (process.argv[1]?.includes('fragment-session')) {
  (async () => {
    console.log('Checking Fragment session...');
    const result = await checkSession(true);
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  })();
}
