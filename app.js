// app.js — StarFabrica (ESM), без MTProto
import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import dayjs from 'dayjs';
import path from 'path';
import { fileURLToPath } from 'url';

// ➕ добавлено
import { spawn } from 'child_process';
import fs from 'fs';

// Проверка сессии Fragment
import { checkSession, isSessionValid, invalidateCache, getSessionInfo } from './scripts/fragment-session.js';


/* ── ENV ─────────────────────────────────────────── */
const {
  BOT_TOKEN, ADMIN_CHAT_ID, PORT = 3000,
  SUPPORT_URL,
  WELCOME_STICKER,

  // подписи вебхуков
  WEBHOOK_SECRET_CRYPTO, WEBHOOK_SECRET_RUB,

  // внешние чекауты (если нужны)
  CHECKOUT_CRYPTO,
  CHECKOUT_RUB,

  DELIVERY_ETA_MIN = 15,

  // СБП (QRManager)
  QRM_BASE, QRM_TOKEN, PUBLIC_BASE,

  // поведение
  AUTODELIVER = '1',

  // ценообразование
  RUB_PER_STAR = '1.8',
  USDT_PER_STAR = '0.028',

  // отмена заказов
  CANCEL_AFTER_MIN = '5',
  
} = process.env;

if (!BOT_TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }

/* ── DB ──────────────────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const db = new Database(path.join(__dirname, 'db', 'starfall.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  username TEXT,
  stars INTEGER NOT NULL,
  price_rub INTEGER,
  price_usdt REAL,
  currency TEXT,
  status TEXT NOT NULL,
  provider_tx TEXT,
  gift_to TEXT,
  admin_msg_id INTEGER,
  sbp_operation_id TEXT,
  sbp_number TEXT,
  sbp_qr_link TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS delivery_queue(
  order_id TEXT PRIMARY KEY,
  try_count INTEGER DEFAULT 0,
  last_error TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sbp_watch(
  order_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tries INTEGER DEFAULT 0,
  next_check_at INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sbp_watch_next ON sbp_watch(next_check_at);
`);

try { db.exec(`ALTER TABLE orders ADD COLUMN gift_to TEXT`); } catch {}
try { db.exec(`ALTER TABLE orders ADD COLUMN admin_msg_id INTEGER`); } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN sbp_operation_id TEXT'); } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN sbp_number TEXT'); } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN sbp_qr_link TEXT'); } catch {}

const qIns = db.prepare(`
  INSERT INTO orders(id,user_id,username,stars,price_rub,price_usdt,status,gift_to)
  VALUES (?,?,?,?,?,?,?,?)
`);
const qGet = db.prepare(`SELECT * FROM orders WHERE id=?`);
const qLast = db.prepare(`SELECT id,stars,status,currency,created_at FROM orders ORDER BY created_at DESC LIMIT ?`);
const qPaid = db.prepare(`UPDATE orders SET status='paid', currency=?, provider_tx=? WHERE id=?`);
const qDelivered = db.prepare(`UPDATE orders SET status='delivered' WHERE id=? AND status='paid'`);
const qSetAdminId = db.prepare(`UPDATE orders SET admin_msg_id=? WHERE id=?`);
const qSetSbpInfo = db.prepare(`
  UPDATE orders SET sbp_operation_id=?, sbp_number=?, sbp_qr_link=? WHERE id=?
`);
const dqCols = db.prepare("PRAGMA table_info(delivery_queue)").all().map(r => r.name);
const hasCreatedAt = dqCols.includes('created_at');
const qEnq = hasCreatedAt
  ? db.prepare(`INSERT OR IGNORE INTO delivery_queue (order_id, created_at) VALUES (?, strftime('%s','now'))
    `)
  : db.prepare(`INSERT OR IGNORE INTO delivery_queue (order_id) VALUES (?)
    `);
const qPop  = db.prepare(`
  SELECT q.order_id, o.user_id, o.username, o.gift_to, o.stars, o.admin_msg_id
  FROM delivery_queue q JOIN orders o ON o.id=q.order_id
  WHERE o.status='paid'
  ORDER BY q.updated_at ASC
  LIMIT 1
`);
const qBump = db.prepare(`UPDATE delivery_queue SET try_count=try_count+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=?`);
const qTries= db.prepare(`SELECT try_count FROM delivery_queue WHERE order_id=?`);
const qDelQ = db.prepare(`DELETE FROM delivery_queue WHERE order_id=?`);

// --- username guard (self) ---
const _awaitName = new Map();   // userId -> { mode:'self' }
const _savedName = new Map();   // userId -> '@name'

// ↓ 4–32, чтобы премиальные короткие никнеймы не отбрасывались
const AT_RE = /^@[\w\d_]{4,32}$/i;
const normAt = (s='') => {
  s = String(s).trim();
  if (!s) return '';
  return s.startsWith('@') ? s : '@' + s;
};
async function validateAt(bot, atName) {
  // Валидируем только формат: 4–32 символа (латиница, цифры, _)
  // Проверка существования невозможна через Bot API.
  const RE = /^@[A-Za-z0-9_]{4,32}$/;
  if (!RE.test(atName)) {
    return { ok: false, err: 'Нужен публичный @username (от 4 до 32 символов: латиница, цифры, подчёркивание).' };
  }
  return { ok: true };
}
function resolveBuyerAt(ctx) {
  const fromAt = ctx.from?.username ? '@' + ctx.from.username : '';
  if (AT_RE.test(fromAt)) return fromAt;
  const mem = _savedName.get(ctx.from.id) || '';
  return AT_RE.test(mem) ? mem : '';
}
async function askBuyerAt(ctx) {
  _awaitName.set(ctx.from.id, { mode:'self' });
  return ctx.reply(
    'Мне нужен ваш публичный @username для доставки звёзд.\n' +
    'Откройте: Настройки → Имя пользователя, или пришлите его сюда (в виде @nickname).',
    Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'back_home')]])
  );
}

/* ── UTILS ───────────────────────────────────────── */
const PACKS = [70, 100, 250, 500, 1000, 2500];

// Проверка админа по userId (без ctx)
const isAdminUser = (userId) => {
  const id = String(userId);
  return id === String(ADMIN_CHAT_ID) || id === String(process.env.ADMIN_USER_ID);
};

// Расчёт цены (для админа — 1 RUB для тестирования)
const calcPrice = (s, userId = null) => {
  if (userId && isAdminUser(userId)) {
    return { rub: 1, usdt: 0.01 }; // тестовая цена для админа
  }
  return {
    rub: Math.round(s * Number(RUB_PER_STAR || 1.8)),
    usdt: +(s * Number(USDT_PER_STAR || 0.028)).toFixed(2)
  };
};
const isSigned = (req, secret) => !!secret && (req.get('X-Sign') || req.get('x-sign')) === secret;
const uname = (u) => u?.username ? `@${u.username}` : `id:${u?.id}`;
const adminMsg = (bot, text, o) => ADMIN_CHAT_ID &&
  bot.telegram.sendMessage(Number(ADMIN_CHAT_ID), text, { parse_mode:'HTML', reply_to_message_id: o?.admin_msg_id }).catch(()=>{});

// Проверка, является ли пользователь админом (с ctx)
const isAdmin = (ctx) => {
  const userId = String(ctx.from?.id);
  return isAdminUser(userId);
};


// назначение платежа
const sanitizePurpose = (s) =>
  String(s ?? '')
    .replace(/[^\w\s.,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);


// клавиатура оплаты
const paymentKb = (sbp, id, rub, usdt) => Markup.inlineKeyboard(
  [
    sbp?.qrLink ? [Markup.button.url('🏦 Оплатить СБП', sbp.qrLink)] : [],
    CHECKOUT_RUB ? [Markup.button.url('💳 Оплатить RUB', `${CHECKOUT_RUB}?order=${id}&amount=${rub}`)] : [],
    CHECKOUT_CRYPTO ? [Markup.button.url('🪙 Оплатить криптой', `${CHECKOUT_CRYPTO}?order=${id}&amount=${usdt}`)] : [],
    sbp?.operationId ? [Markup.button.callback('🔄 Проверить оплату СБП', `check_sbp_${id}`)] : [],
    [Markup.button.callback('Назад', 'back_home')]
  ].filter(r => r.length)
);

/* ── QRManager client ───────────────────────────── */
async function qrmRequest(urlPath, { method = 'POST', body } = {}) {
  if (!QRM_BASE || !QRM_TOKEN) throw new Error('QRManager env missing');
  const res = await fetch(`${QRM_BASE.replace(/\/$/, '')}${urlPath}`, {
    method,
    headers: {
      'X-Api-Key': QRM_TOKEN,
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`QRManager ${method} ${urlPath} ${res.status}: ${t}`);
  }
  return res.json();
}

// POST /operations/qr-code/
async function createSbpPayment({ orderId, amountRub, comment }) {
  const payload = {
    sum: Math.round(Number(amountRub) * 100),
    qr_size: 400,
    payment_purpose: sanitizePurpose(comment || `Order ${orderId}`),
    notification_url: `${(PUBLIC_BASE || '').replace(/\/$/, '')}/webhook/sbp`,
    ttl: Number(process.env.QRM_TTL_SEC || 300)   // ← 5 минут по умолчанию
  };
  const data = await qrmRequest('/operations/qr-code/', { body: payload });
  const r = data.results || data;
  return {
    operationId: r.operation_id || r.operationId,
    number     : r.number || null,
    qrLink     : r.qr_link || (r.qr && (r.qr.url || r.qr.link)) || null
  };
}

// GET /operations/{id}/qr-status/
async function getSbpStatus(operationId) {
  const data = await qrmRequest(`/operations/${operationId}/qr-status/`, { method: 'GET' });
  const r = data.results || data;
  const code = Number(r.operation_status_code);
  return { status: r.operation_status_msg || String(code), paid: code === 5 };
}

/* ── BOT ─────────────────────────────────────────── */
const bot = new Telegraf(BOT_TOKEN);
globalThis._gift = globalThis._gift || new Map();      // userId -> {stage:'await_user'|'pick_pack', gift_to}
globalThis._flow = globalThis._flow || new Map();      // userId -> {wait:'qty_self'}

bot.command('restart', async (ctx) => {
  const { text, markup } = inlineHome('🔄 Перезапуск. Выберите действие:');
  try {
    return await ctx.reply(text, markup);
  } catch (e) {
    console.error('restart error:', e.message);
  }
});

function inlineHome(text = '✨ Добро пожаловать! Здесь вы можете купить Звезды без ограничений (оплатить СБП без прохождения KYC).\n' +
  'Кнопки ниже помогут совершить покупку!\n' + 'Нажимай "⭐ Купить себе", вводи количество вручную или выбирай пакет и получай звезды за считанные секунды! ') {
  return {
    text,
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('⭐ Купить себе', 'buy_menu')],
      [Markup.button.callback('🎁 Купить другу', 'gift_start')],
      [Markup.button.url('🛒 Открыть мини-апп', 'https://shop.starsfabrica.store')],
      [
        Markup.button.callback('🔁 Перезапуск', 'restart_home'),
        Markup.button.url('🆘 Поддержка', SUPPORT_URL)
      ]
    ])
  };
}

// /start — стикер (если есть) + одно сообщение с inline-меню
bot.start(async (ctx) => {
  if (WELCOME_STICKER) {
    try { await ctx.replyWithSticker(WELCOME_STICKER); } catch {}
  }
  const { text, markup } = inlineHome();
  return ctx.reply(text, markup);
});

// Перезапуск (inline) — возвращаемся к дому
bot.action('restart_home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const { text, markup } = inlineHome('🔄 Перезапуск. Выберите действие:');
  try {
    return await ctx.editMessageText(text, markup);
  } catch {
    return ctx.reply(text, markup);
  }
});

// Назад — тоже всегда восстанавливает дом с инлайном
bot.action('back_home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const { text, markup } = inlineHome('◀️ Вернулись назад.');
  try {
    return await ctx.editMessageText(text, markup);
  } catch {
    return ctx.reply(text, markup);
  }
});


/* меню покупки себе */
bot.action('buy_menu', ctx => {
  const rows = [
    [Markup.button.callback('🔢 Другое количество', 'custom_qty_self')],
    ...PACKS.map(p => [Markup.button.callback(`✨ ${p} звёзд`, `buy_${p}`)]),
    [Markup.button.callback('Назад', 'back_home')]
  ];
  return ctx.editMessageText('⭐ Выбери пакет или нажми «Другое количество»:',
    Markup.inlineKeyboard(rows));
});

/* покупка себе — фикс пакеты */
bot.action(/buy_(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  const stars = +ctx.match[1];

  // ПРЕДОХРАНИТЕЛЬ: просим @username, если у пользователя его нет
  let buyerAt = resolveBuyerAt(ctx);
  if (!buyerAt) { await askBuyerAt(ctx); return; }
  const { rub, usdt } = calcPrice(stars, ctx.from.id);
  const id = uuid();

  const buyerName = (buyerAt || '').replace(/^@/, '');
  qIns.run(id, ctx.from.id, buyerName, stars, rub, usdt, 'created', null);

  let sbp = {};
  try {
    sbp = await createSbpPayment({ orderId: id, amountRub: rub, comment: `Stars ${stars} id ${id}` });
    qSetSbpInfo.run(sbp.operationId || null, sbp.number || null, sbp.qrLink || null, id);
    if (sbp.operationId) {
      db.prepare('INSERT OR REPLACE INTO sbp_watch(order_id, operation_id, tries, next_check_at) VALUES (?,?,0,?)')
        .run(id, sbp.operationId, Date.now() + 15_000);
    }
  } catch (e) {
    console.error('SBP create error:', e.message);
  }

  await ctx.editMessageText(
`✅ Заказ создан, время на оплату 5 минут

🧾 Номер: ${id}
⭐ Пакет: ${stars} звёзд
💸 К оплате: ${rub}₽ или ${usdt} USDT`,
    paymentKb(sbp, id, rub, usdt)
  );

  if (ADMIN_CHAT_ID) {
    try {
      const m = await bot.telegram.sendMessage(
        Number(ADMIN_CHAT_ID),
        `🆕 <b>Новый заказ</b>\n🧾 <code>${id}</code>\n⭐ ${stars}\n💸 ${rub}₽ / ${usdt} USDT\n👤 ${uname(ctx.from)}`,
        { parse_mode:'HTML' }
      );
      qSetAdminId.run(m.message_id, id);
    } catch {}
  }
});

/* покупка себе — произвольное количество */
bot.action('custom_qty_self', async ctx => {
  await ctx.answerCbQuery(); _flow.set(ctx.from.id, { wait: 'qty_self' });
  return ctx.reply('Введите количество звёзд числом (от 70 до 1 000 000):',
    Markup.inlineKeyboard([[Markup.button.callback('Назад', 'back_home')]]));
});

/* подарок — поток */
bot.action('gift_start', async ctx => {
  await ctx.answerCbQuery(); _gift.set(ctx.from.id, { stage: 'await_user' });
  return ctx.reply('🎁 Введите @юзернейм друга (или его ID):',
    Markup.inlineKeyboard([[Markup.button.callback('Назад', 'back_home')]]));
});
bot.action('gift_custom_qty', async ctx => {
  await ctx.answerCbQuery(); const st = _gift.get(ctx.from.id);
  if (!st || st.stage!=='pick_pack') return ctx.answerCbQuery('Сначала введите получателя',{show_alert:true});
  return ctx.reply('Введите нужное количество звёзд числом (от 70 до 1 000 000):');
});
bot.action(/gift_(\d+)/, async ctx => {
  await ctx.answerCbQuery(); const st = _gift.get(ctx.from.id);
  if (!st || st.stage!=='pick_pack' || !st.gift_to) return ctx.answerCbQuery('Сначала введите получателя',{show_alert:true});
  await createGiftOrder(ctx, +ctx.match[1], st.gift_to); _gift.delete(ctx.from.id);
});

/* универсальный приём текста: получатель подарка / произвольное число */
bot.on('text', async (ctx, next) => {
  const txt = (ctx.message.text || '').trim();

  // 0) ожидаем @username для «покупка себе»
  const stU = _awaitName.get(ctx.from.id);
  if (stU?.mode === 'self') {
    const at = normAt(txt);
    const v = await validateAt(bot, at);
    if (!v.ok) return ctx.reply('❗ ' + v.err);

    _savedName.set(ctx.from.id, at);
    _awaitName.delete(ctx.from.id);

    return ctx.reply(
      '✅ Готово! Теперь выберите пакет или введите количество:',
      Markup.inlineKeyboard([
        [Markup.button.callback('🔢 Другое количество', 'custom_qty_self')],
        ...PACKS.map(p => [Markup.button.callback(`✨ ${p} звёзд`, `buy_${p}`)]),
        [Markup.button.callback('Назад', 'back_home')]
      ])
    );
  }

  // подарок: ввод получателя (валидируем @username)
  const stG = _gift.get(ctx.from.id);
  if (stG?.stage === 'await_user') {
    const at = normAt(txt);
    const v = await validateAt(bot, at);
    if (!v.ok) return ctx.reply('❗ ' + v.err);

    _gift.set(ctx.from.id, { stage: 'pick_pack', gift_to: at });
    const rows = [
      [Markup.button.callback('🔢 Другое количество', 'gift_custom_qty')],
      ...PACKS.map(p => [Markup.button.callback(`✨ ${p} звёзд`, `gift_${p}`)]),
      [Markup.button.callback('Назад', 'back_home')]
    ];
    return ctx.reply(`Ок! 🎉 Покупаем звёзды для ${at}. Выберите пакет или введите своё количество:`,
      Markup.inlineKeyboard(rows));
  }

  // подарок: пользователь ввёл число вместо кнопки
  if (stG?.stage === 'pick_pack' && stG?.gift_to) {
    const stars = parseStars(txt);
    if (stars) { await createGiftOrder(ctx, stars, stG.gift_to); _gift.delete(ctx.from.id); }
    else return ctx.reply('Число вне диапазона. Введите от 70 до 1 000 000.');
    return;
  }

  // покупка себе: произвольное число
  const stF = _flow.get(ctx.from.id);
  if (stF?.wait === 'qty_self') {
    const stars = parseStars(txt);
    if (!stars) return ctx.reply('Число вне диапазона. Введите от 70 до 1 000 000.');

    // гарантируем наличие валидного @username
    let buyerAt = resolveBuyerAt(ctx);
    if (!buyerAt) { await askBuyerAt(ctx); return; }

    const { rub, usdt } = calcPrice(stars, ctx.from.id);
    const id = uuid();

    qIns.run(id, ctx.from.id, (buyerAt||'').replace(/^@/,''), stars, rub, usdt, 'created', null);

    let sbp = {};
    try {
      sbp = await createSbpPayment({ orderId: id, amountRub: rub, comment: `Stars ${stars} id ${id}` });
      qSetSbpInfo.run(sbp.operationId || null, sbp.number || null, sbp.qrLink || null, id);
      if (sbp.operationId) {
        db.prepare('INSERT OR REPLACE INTO sbp_watch(order_id, operation_id, tries, next_check_at) VALUES (?,?,0,?)')
          .run(id, sbp.operationId, Date.now() + 15_000);
      }
    } catch (e) {
      console.error('SBP create error:', e.message);
    }

    await ctx.reply(
`✅ Заказ создан, время на оплату 5 минут

🧾 Номер: ${id}
⭐ Пакет: ${stars} звёзд
💸 К оплате: ${rub}₽ или ${usdt} USDT
`,
      paymentKb(sbp, id, rub, usdt)
    );

    if (ADMIN_CHAT_ID) {
      try {
        const m = await bot.telegram.sendMessage(
          Number(ADMIN_CHAT_ID),
          `🆕 <b>Новый заказ</b>\n🧾 <code>${id}</code>\n⭐ ${stars}\n💸 ${rub}₽ / ${usdt} USDT\n👤 ${uname(ctx.from)}`,
          { parse_mode: 'HTML' }
        );
        qSetAdminId.run(m.message_id, id);
      } catch (e) {
        console.error('admin notify (custom qty):', e?.description || e?.message || e);
      }
    }

    _flow.delete(ctx.from.id);
    return;
  }
  return next();
});

function parseStars(s) {
  const n = parseInt(String(s).replace(/\D/g,''), 10);
  return Number.isFinite(n) && n >= 70 && n <= 1_000_000 ? n : null;
}

async function createGiftOrder(ctx, stars, giftTo) {
  const { rub, usdt } = calcPrice(stars, ctx.from.id); const id = uuid();
  qIns.run(id, ctx.from.id, ctx.from.username || '', stars, rub, usdt, 'created', giftTo);

  let sbp = {};
  try {
    sbp = await createSbpPayment({ orderId: id, amountRub: rub, comment: `Gift ${stars} id ${id}` });
    qSetSbpInfo.run(sbp.operationId || null, sbp.number || null, sbp.qrLink || null, id);
    if (sbp.operationId) {
      db.prepare('INSERT OR REPLACE INTO sbp_watch(order_id, operation_id, tries, next_check_at) VALUES (?,?,0,?)')
        .run(id, sbp.operationId, Date.now() + 15_000);
    }
  } catch (e) {
    console.error('SBP create error:', e.message);
  }


  await ctx.reply(
`✅ Заказ создан (🎁 для ${giftTo})

🧾 Номер: ${id}
⭐ Пакет: ${stars} звёзд
💸 К оплате: ${rub}₽ или ${usdt} USDT
`,
    paymentKb(sbp, id, rub, usdt)
  );

  if (ADMIN_CHAT_ID) try {
    const m = await bot.telegram.sendMessage(Number(ADMIN_CHAT_ID),
      `🆕 <b>Новый заказ (ПОДАРОК)</b>\n🧾 <code>${id}</code>\n⭐ ${stars}\n💸 ${rub}₽ / ${usdt} USDT\n👤 ${uname(ctx.from)}\n🎁 Получатель: ${giftTo}`, { parse_mode:'HTML' });
    qSetAdminId.run(m.message_id, id);
  } catch {}
}

/* проверка СБП вручную */
bot.action(/check_sbp_(.+)/, async ctx => {
  await ctx.answerCbQuery();
  const orderId = ctx.match[1];
  const o = qGet.get(orderId);
  if (!o) return ctx.reply('⛔ Заказ не найден');
  if (!o.sbp_operation_id) return ctx.reply('Для заказа нет операции СБП');

  try {
    const st = await getSbpStatus(o.sbp_operation_id);
    if (st.paid) {
      await onPaid('RUB', orderId, o.sbp_operation_id);
      return ctx.reply('✅ Оплата по СБП подтверждена. Спасибо!');
    }
    return ctx.reply(`Статус: ${st.status || 'UNKNOWN'}. Если уже оплачивали — повторите проверку позже.`);
  } catch (e) {
    console.error('SBP status error:', e.message);
    return ctx.reply('Не удалось проверить статус. Попробуйте позднее.');
  }
});

/* мини-админ */
bot.command('last', ctx => {
  if (!isAdmin(ctx)) return;
  const rows = qLast.all(5);
  if (!rows.length) return ctx.reply('Пока пусто');
  ctx.reply(rows.map(o => `🧾 <code>${o.id}</code>\n⭐ ${o.stars}\n💳 ${o.status}${o.currency?` (${o.currency})`:''}\n🕒 ${dayjs(o.created_at).format('YYYY-MM-DD HH:mm')}`)
    .join('\n\n'), { parse_mode:'HTML' });
});
bot.command('o', ctx => {
  const [, id] = (ctx.message.text||'').split(/\s+/,2);
  if (!id) return ctx.reply('Usage: /o <orderId>');
  const o = qGet.get(id); if (!o) return ctx.reply('⛔ Не найдено');
  ctx.reply([
    `🧾 ID: ${o.id}`,
    `⭐ Звёзд: ${o.stars}`,
    `💳 Статус: ${o.status}${o.currency?` (${o.currency})`:''}`,
    o.provider_tx ? `🧷 Tx: ${o.provider_tx}` : null,
    o.gift_to ? `🎁 Получатель: ${o.gift_to}` : null,
    `🕒 ${dayjs(o.created_at).format('YYYY-MM-DD HH:mm')}`
  ].filter(Boolean).join('\n'));
});

/* ── КОМАНДЫ УПРАВЛЕНИЯ СЕССИЕЙ FRAGMENT ── */

// /session — проверка статуса сессии
bot.command('session', async ctx => {
  if (!isAdmin(ctx)) return;
  
  await ctx.reply('🔍 Проверяю сессию Fragment...');
  
  try {
    const result = await checkSession(true); // force check
    
    if (result.valid) {
      return ctx.reply(
        `✅ <b>Сессия Fragment активна</b>\n\n` +
        `🔐 API Hash: <code>${result.hash?.slice(0,8)}...</code>\n` +
        `⏱ Проверено: ${new Date(result.checkedAt).toLocaleString('ru-RU')}`,
        { parse_mode: 'HTML' }
      );
    } else {
      return ctx.reply(
        `⛔ <b>Сессия Fragment НЕ активна</b>\n\n` +
        `❌ Ошибка: ${result.error || 'Unknown'}\n\n` +
        `💡 Выполните на сервере:\n<code>npm run open</code>\n\n` +
        `Затем авторизуйтесь на fragment.com и нажмите Enter в терминале.`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    return ctx.reply(`❌ Ошибка проверки: ${e.message}`);
  }
});

// /reauth — инструкции по реавторизации
bot.command('reauth', ctx => {
  if (!isAdmin(ctx)) return;
  
  invalidateCache(); // сбрасываем кэш сессии
  
  return ctx.reply(
    `🔄 <b>Реавторизация Fragment</b>\n\n` +
    `1️⃣ SSH на сервер\n` +
    `2️⃣ Перейти в папку проекта\n` +
    `3️⃣ Выполнить: <code>npm run open</code>\n` +
    `4️⃣ Авторизоваться в открывшемся браузере\n` +
    `5️⃣ Нажать Enter в терминале\n\n` +
    `После этого проверьте: /session`,
    { parse_mode: 'HTML' }
  );
});

// /freebuy <recipient> <amount> — тестовая покупка без оплаты
bot.command('freebuy', async ctx => {
  if (!isAdmin(ctx)) return;
  
  const args = ctx.message.text.split(/\s+/).slice(1);
  const recipient = args[0] || ctx.from.username || `id:${ctx.from.id}`;
  const stars = parseInt(args[1]) || 70;
  
  await ctx.reply(`🧪 <b>Тестовая покупка</b>\n\n📨 Получатель: ${recipient}\n⭐ Звёзд: ${stars}\n\n⏳ Создаю заказ...`, { parse_mode: 'HTML' });
  
  try {
    // Создаём тестовый заказ
    const orderId = uuid();
    const rubAmount = stars * 2.5; // примерная цена
    
    db.prepare(`
      INSERT INTO orders (id, user_id, username, stars, price_rub, gift_to, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).run(orderId, ctx.from.id, ctx.from.username || null, stars, rubAmount, recipient.replace('@', ''));
    
    await ctx.reply(`✅ Заказ создан: <code>${orderId}</code>\n\n🚀 Запускаю покупку...`, { parse_mode: 'HTML' });
    
    // Симулируем оплату и запускаем доставку
    await onPaid('TEST', orderId, 'test-tx-' + Date.now());
    
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
});

// /deliver <order_id> — ручной повторный запуск доставки
bot.command('deliver', async ctx => {
  if (!isAdmin(ctx)) return;
  
  const orderId = ctx.message.text.split(/\s+/)[1];
  if (!orderId) {
    return ctx.reply('❌ Укажи ID заказа:\n<code>/deliver abc123-def456</code>', { parse_mode: 'HTML' });
  }
  
  const order = qGet.get(orderId);
  if (!order) {
    return ctx.reply(`❌ Заказ <code>${orderId}</code> не найден`, { parse_mode: 'HTML' });
  }
  
  if (order.status === 'delivered') {
    return ctx.reply(`✅ Заказ уже доставлен\n🧾 <code>${orderId}</code>`, { parse_mode: 'HTML' });
  }
  
  await ctx.reply(
    `🔄 <b>Запускаю доставку</b>\n\n` +
    `🧾 <code>${orderId}</code>\n` +
    `⭐ ${order.stars}\n` +
    `📨 ${order.gift_to || order.username || 'id:' + order.user_id}\n` +
    `📌 Статус: ${order.status}`,
    { parse_mode: 'HTML' }
  );
  
  try {
    // Удаляем expired pending файл если есть
    const pendingPath = path.join(LOG_DIR, `pending-${orderId}.json`);
    const lockPath = path.join(LOG_DIR, `seqno-${orderId}.lock`);
    
    if (fs.existsSync(pendingPath)) {
      try {
        const p = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        const now = Math.floor(Date.now() / 1000);
        if (p?.transaction?.validUntil && now > p.transaction.validUntil) {
          fs.unlinkSync(pendingPath);
          if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
          await ctx.reply('⚠️ Удалён истёкший pending файл');
        }
      } catch {}
    }
    
    // Добавляем в очередь доставки
    db.prepare(`INSERT OR REPLACE INTO delivery_queue (order_id, try_count) VALUES (?, 0)`).run(orderId);
    
    // Если статус ещё не paid — ставим paid
    if (order.status !== 'paid') {
      db.prepare(`UPDATE orders SET status='paid' WHERE id=?`).run(orderId);
    }
    
    await ctx.reply('✅ Заказ добавлен в очередь доставки. Жди ~10 сек.');
    
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
});

// /status <order_id> — проверка статуса заказа
bot.command('status', async ctx => {
  if (!isAdmin(ctx)) return;
  
  const orderId = ctx.message.text.split(/\s+/)[1];
  if (!orderId) {
    return ctx.reply('❌ Укажи ID заказа:\n<code>/status abc123-def456</code>', { parse_mode: 'HTML' });
  }
  
  const order = qGet.get(orderId);
  if (!order) {
    return ctx.reply(`❌ Заказ <code>${orderId}</code> не найден`, { parse_mode: 'HTML' });
  }
  
  const inQueue = db.prepare(`SELECT * FROM delivery_queue WHERE order_id=?`).get(orderId);
  const pendingPath = path.join(LOG_DIR, `pending-${orderId}.json`);
  let pendingInfo = 'нет';
  
  if (fs.existsSync(pendingPath)) {
    try {
      const p = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      const now = Math.floor(Date.now() / 1000);
      const left = (p?.transaction?.validUntil || 0) - now;
      pendingInfo = `${p.state} (${left > 0 ? left + 's left' : 'EXPIRED'})`;
    } catch { pendingInfo = 'ошибка чтения'; }
  }
  
  await ctx.reply(
    `📋 <b>Заказ</b>\n\n` +
    `🧾 <code>${order.id}</code>\n` +
    `📌 Статус: <b>${order.status}</b>\n` +
    `⭐ ${order.stars}\n` +
    `👤 ${order.username ? '@' + order.username : 'id:' + order.user_id}\n` +
    (order.gift_to ? `🎁 Получатель: ${order.gift_to}\n` : '') +
    `💱 ${order.currency || '-'}\n` +
    `🕒 ${dayjs(order.created_at).format('YYYY-MM-DD HH:mm')}\n\n` +
    `📦 В очереди: ${inQueue ? `да (попыток: ${inQueue.try_count})` : 'нет'}\n` +
    `📄 Pending: ${pendingInfo}`,
    { parse_mode: 'HTML' }
  );
});
/* ── HTTP ────────────────────────────────────────── */
const app = express(); app.use(express.json());
app.get('/health', (_,res)=>res.json({ok:true,ts:Date.now()}));

app.post('/webhook/crypto', async (req,res)=>{
  if (!isSigned(req, WEBHOOK_SECRET_CRYPTO)) return res.status(401).end('Unauthorized');
  const { orderId, status, txId } = req.body || {};
  if (!orderId) return res.status(400).json({ ok:false, error:'orderId required' });
  if (status === 'paid') await onPaid('USDT', orderId, txId);
  res.json({ok:true});
});

app.post('/webhook/rub', async (req,res)=>{
  if (!isSigned(req, WEBHOOK_SECRET_RUB)) return res.status(401).end('Unauthorized');
  const { orderId, status, txId } = req.body || {};
  if (!orderId) return res.status(400).json({ ok:false, error:'orderId required' });
  if (status === 'paid') await onPaid('RUB', orderId, txId);
  res.json({ok:true});
});

/* вебхук СБП (QRManager) */
app.post('/webhook/sbp', async (req, res) => {
  try {
    const p = req.body || {};
    const operationId = p.id || p.operation_id || p.operationId;
    const number      = p.number || p.sbp_number || null;
    const code        = Number(p.operation_status_code ?? p.code ?? p.status_code);

    if (!operationId) return res.status(400).json({ ok:false, error:'missing operation id' });

    const o = db.prepare(
      'SELECT * FROM orders WHERE sbp_operation_id = ? OR sbp_number = ?'
    ).get(operationId, number);

    if (!o) {
      console.warn('SBP webhook: order not found', { operationId, number, code });
      return res.json({ ok:true, note:'order not found' });
    }

    if (code === 5) { // оплачено
      if (o.status !== 'paid' && o.status !== 'delivered') {
        await onPaid('RUB', o.id, operationId);
      }
      db.prepare('DELETE FROM sbp_watch WHERE order_id = ?').run(o.id);
    } else {
      db.prepare(`
        INSERT OR IGNORE INTO sbp_watch(order_id, operation_id, tries, next_check_at)
        VALUES (?, ?, 0, ?)
      `).run(o.id, operationId, Date.now() + 15_000);
    }

    res.json({ ok:true });
  } catch (e) {
    console.error('SBP webhook error:', e?.stack || e?.message || e);
    res.status(500).json({ ok:false });
  }
});

/* оплата прошла — идемпотентно */
async function onPaid(currency, orderId, txId) {
  // обновляем только если заказ ещё НЕ был paid/delivered
  const upd = db.prepare(`
    UPDATE orders
       SET status='paid', currency=?, provider_tx=?
     WHERE id=? AND status NOT IN ('paid','delivered')
  `).run(currency, txId || null, orderId);

  // если изменений нет — это повторный вызов/вебхук, выходим
  if (upd.changes === 0) {
    console.log('onPaid: duplicate or already delivered, skip', orderId);
    return;
  }

  const o = qGet.get(orderId);
  if (!o) return;

  const paidText =
    `✅ <b>Оплата получена</b>\n` +
    `🧾 <code>${o.id}</code>\n` +
    `⭐ ${o.stars}\n` +
    `💱 ${currency}\n` +
    `📌 Статус: paid\n` +
    `👤 ${o.username ? '@'+o.username : 'id:'+o.user_id}\n` +
    (o.gift_to ? `🎁 Получатель: ${o.gift_to}\n` : '') +
    `🧷 <code>${txId || '-'}</code>`;

  adminMsg(bot, paidText, o);

  try {
    await bot.telegram.sendMessage(
      o.user_id,
      `✅ Оплата получена.\n` +
      (o.gift_to ? `🎁 Подарок будет отправлен: ${o.gift_to}\n` : '') +
      `Доставка ${o.stars} ⭐ займёт ~${DELIVERY_ETA_MIN} мин.`
    );
  } catch {}

  // ставим в очередь (idempotent: PRIMARY KEY в delivery_queue не даст дубль)
  qEnq.run(orderId);
}


/* ── CHAIN RUNNER: buy.js → send.js ───────────────── */
// пути/логи
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// запуск node-скрипта в том же окружении
function runScript(file, args = [], extraEnv = {}, logName = '') {
  return new Promise((resolve, reject) => {
    const node = process.execPath;
    const scriptPath = path.join(SCRIPTS_DIR, file);
    const logPath = path.join(LOG_DIR, logName || `run-${Date.now()}.log`);
    const out = fs.createWriteStream(logPath, { flags: 'a' });

    const child = spawn(
      node,
      ['-r', 'dotenv/config', scriptPath, ...args],
      { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    child.stdout.pipe(out);
    child.stderr.pipe(out);

    child.on('close', (code) => {
      out.end();
      code === 0 ? resolve({ ok: true, logPath }) : reject(new Error(`${file} exited ${code}`));
    });
  });
}


async function deliverStars(job) {
  const recipient =
    (job.gift_to && job.gift_to.trim()) ||
    (job.username ? `@${job.username}` : null);
  if (!recipient) return { ok: false, reason: 'no_recipient' };

  const orderId     = job.order_id;
  const pendingPath = path.join(LOG_DIR, `pending-${orderId}.json`);
  const buyLog      = `run-buy-${orderId}.log`;
  const sendLog     = `run-send-${orderId}.log`;
  const seqnoLock   = path.join(LOG_DIR, `seqno-${orderId}.lock`);

  const DEF_PENDING = path.join(LOG_DIR, 'pending-tx.json'); // вдруг buy.js пишет сюда

  const isValidPending = (p) => {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return j?.state === 'ready'
        && j?.transaction?.validUntil
        && Math.floor(Date.now() / 1000) < Number(j.transaction.validUntil);
    } catch { return false; }
  };

  try {
    // 1) если уже есть валидный pending-<orderId> — используем его
    let haveValid = fs.existsSync(pendingPath) && isValidPending(pendingPath);

    // 2) иначе пробуем дефолтный файл от buy.js и копируем его в per-order
    if (!haveValid && fs.existsSync(DEF_PENDING) && isValidPending(DEF_PENDING)) {
      fs.copyFileSync(DEF_PENDING, pendingPath);
      haveValid = true;
    }

    // 3) если всё ещё нет — создаём новый заказ на Fragment
    if (!haveValid) {
      await runScript(
        'buy.js',
        [recipient, String(job.stars)],
        { PENDING_PATH: pendingPath },        // просим писать в per-order
        buyLog
      );

      // если buy всё равно записал в DEF_PENDING — копируем
      if (!fs.existsSync(pendingPath) && fs.existsSync(DEF_PENDING)) {
        fs.copyFileSync(DEF_PENDING, pendingPath);
      }
      if (!fs.existsSync(pendingPath) || !isValidPending(pendingPath)) {
        return { ok: false, reason: 'pending_not_ready' };
      }
    }

    // 4) платим (с seqno-lock на заказ)
    await runScript(
      'send.js',
      [],
      { PENDING_PATH: pendingPath, SEQNO_LOCK_PATH: seqnoLock },
      sendLog
    );

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || 'send_failed' };
  }
}
const IN_PROGRESS = new Set();
const TICK = 5000, MAX_TRIES = 8;
setInterval(async () => {
  let j;
  try {
    j = qPop.get();
    if (!j) return;

    // не запускаем второй раз этот же заказ, пока он «в работе»
    if (IN_PROGRESS.has(j.order_id)) return;
    IN_PROGRESS.add(j.order_id);

    const r = await deliverStars(j);

    if (r.ok) {
      // ставим delivered
      const upd = qDelivered.run(j.order_id);   // <- вернёт { changes }
      qDelQ.run(j.order_id);                    // убираем из очереди в любом случае

      // нотификации — только при ПЕРВОМ переходе в delivered
      if (upd.changes > 0) {
        try {
          await bot.telegram.sendMessage(
            j.user_id,
            `🎉 Доставлено ${j.stars} ⭐. Спасибо за заказ!`
          );
        } catch {}

        const o = qGet.get(j.order_id);
        adminMsg(
          bot,
          `✅ <b>Доставка завершена</b>\n` +
          `🧾 <code>${o.id}</code>\n` +
          `⭐ ${o.stars}\n` +
          (o.gift_to ? `🎁 Получатель: ${o.gift_to}\n` : '') +
          `👤 ${o.username ? '@'+o.username : 'id:'+o.user_id}`,
          o
        );
      } else {
        console.log('deliver: already delivered earlier → skip notifications', j.order_id);
      }

    } else {
      qBump.run(r.reason || 'unknown', j.order_id);

      const t = qTries.get(j.order_id)?.try_count || 0;

      if (t >= MAX_TRIES) {
        adminMsg(bot, `⛔ Не удалось доставить <code>${j.order_id}</code> (${t} попыток)`, j);

        qDelQ.run(j.order_id);
      }
    }

  } catch (e) {
    console.error('worker:', e.message);
  } finally {
    if (j) IN_PROGRESS.delete(j.order_id);
  }
}, TICK);


/* авто-пуллинг статусов СБП (если включено) */
if (String(AUTODELIVER) !== '0') {
  const SBP_TICK = 10_000;
  const SBP_MAX_TRIES = 40;

  setInterval(async () => {
    try {
      const now = Date.now();
      const rows = db.prepare('SELECT order_id, operation_id, tries FROM sbp_watch WHERE next_check_at <= ? LIMIT 10').all(now);
      for (const r of rows) {
        try {
          const st = await getSbpStatus(r.operation_id);
          if (st.paid) {
            await onPaid('RUB', r.order_id, r.operation_id);
            db.prepare('DELETE FROM sbp_watch WHERE order_id=?').run(r.order_id);
            continue;
          }
          const tries = r.tries + 1;
          const delay = Math.min(60_000, 15_000 * tries); // 15s, 30s, 45s, ... до 60s
          db.prepare('UPDATE sbp_watch SET tries=?, next_check_at=? WHERE order_id=?')
            .run(tries, Date.now() + delay, r.order_id);

          if (tries >= SBP_MAX_TRIES) {
            db.prepare('DELETE FROM sbp_watch WHERE order_id=?').run(r.order_id);
          }
        } catch (e) {
          console.error('sbp watch check error:', e.message);
          db.prepare('UPDATE sbp_watch SET next_check_at=? WHERE order_id=?')
            .run(Date.now() + 30_000, r.order_id);
        }
      }
    } catch (e) {
      console.error('sbp watch loop:', e.message);
    }
  }, SBP_TICK);
}


bot.on('sticker', async (ctx) => {
  const s = ctx.message.sticker;
  const info = [
    `🎯 file_id:\n<code>${s.file_id}</code>`,
    `🆔 file_unique_id:\n<code>${s.file_unique_id}</code>`,
    `📦 тип: ${s.is_animated ? 'animated .tgs' : s.is_video ? 'video .webm' : 'static .webp'}`,
    s.set_name ? `🧩 набор: ${s.set_name}` : null,
  ].filter(Boolean).join('\n');
  try { console.log('[sticker]', s); } catch {}
  return ctx.reply(info, { parse_mode: 'HTML' });
});


/* ── START ──────────────────────────────────────── */

// Очистка старых логов (старше 1 дня)
const LOG_CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // каждые 6 часов
const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 день

async function cleanupOldLogs() {
  try {
    const logDir = process.env.LOG_DIR || path.join(__dirname, 'logs');
    const files = await fs.promises.readdir(logDir);
    const now = Date.now();
    let deleted = 0;
    
    for (const file of files) {
      if (file === '.gitkeep') continue;
      const filePath = path.join(logDir, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > LOG_MAX_AGE_MS) {
          await fs.promises.unlink(filePath);
          deleted++;
        }
      } catch {}
    }
    
    if (deleted > 0) {
      console.log(`[cleanup] Deleted ${deleted} old log files`);
    }
  } catch (e) {
    console.error('[cleanup] Error:', e.message);
  }
}

// Health-check сессии Fragment (каждые 10 минут)
const SESSION_CHECK_INTERVAL = 10 * 60 * 1000;
let lastSessionAlertAt = 0;
const SESSION_ALERT_COOLDOWN = 60 * 60 * 1000; // уведомлять не чаще раза в час

async function checkFragmentSession() {
  try {
    const result = await checkSession(true);
    
    if (!result.valid && ADMIN_CHAT_ID) {
      const now = Date.now();
      // Уведомляем не чаще раза в час
      if (now - lastSessionAlertAt > SESSION_ALERT_COOLDOWN) {
        lastSessionAlertAt = now;
        await bot.telegram.sendMessage(
          Number(ADMIN_CHAT_ID),
          `⚠️ <b>Сессия Fragment истекла!</b>\n\n` +
          `❌ Ошибка: ${result.error || 'Unknown'}\n\n` +
          `Доставка звёзд невозможна.\n` +
          `Выполните: /reauth для инструкций`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    } else if (result.valid) {
      lastSessionAlertAt = 0; // сбрасываем при восстановлении
    }
  } catch (e) {
    console.error('[health] Fragment session check error:', e.message);
  }
}

// Запуск сервера и бота
const appInstance = app.listen(PORT, () => console.log(`HTTP on ${PORT}`));
bot.launch().then(() => {
  console.log('Bot polling started');
  
  // Запускаем очистку логов сразу и по интервалу
  cleanupOldLogs();
  setInterval(cleanupOldLogs, LOG_CLEANUP_INTERVAL);
  
  // Запускаем проверку сессии через 30 сек после старта
  setTimeout(() => {
    checkFragmentSession();
    setInterval(checkFragmentSession, SESSION_CHECK_INTERVAL);
  }, 30_000);
});

process.once('SIGINT', () => { bot.stop('SIGINT'); appInstance.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); appInstance.close(); });

