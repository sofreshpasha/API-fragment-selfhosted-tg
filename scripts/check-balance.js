// scripts/check-balance.js
import 'dotenv/config';
import fs from 'fs/promises';
import { WalletContractV5R1, Address } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';

// ==== ENV ====
if (!process.env.TON_API_BASE) throw new Error('Missing TON_API_BASE');
if (!process.env.WALLET_MNEMONIC) throw new Error('Missing WALLET_MNEMONIC');

const TON_API_BASE = process.env.TON_API_BASE.replace(/\/+$/, '');
const TON_API_KEY  = process.env.TON_API_KEY || '';
const PENDING_PATH = process.env.PENDING_PATH || './logs/pending-tx.json';

// ==== Utils ====
const headers = TON_API_KEY ? { Authorization: `Bearer ${TON_API_KEY}` } : {};

async function getJson(url) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
  return await r.json();
}
const fmtTON = (nano) => {
  let n = BigInt(nano);
  const sign = n < 0n ? '-' : '';
  if (n < 0n) n = -n;
  const i = n / 1000000000n;
  const f = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/,'');
  return `${sign}${i}${f ? '.'+f : ''} TON`;
};
function parseAnyAddress(s) {
  try { return Address.parseFriendly(s).address; } catch {}
  return Address.parse(s); // raw 0:... → Address
}
async function readPendingSafe() {
  try { return JSON.parse(await fs.readFile(PENDING_PATH, 'utf8')); }
  catch { return null; }
}

// ==== Main ====
const { publicKey } = await mnemonicToPrivateKey(
  process.env.WALLET_MNEMONIC.trim().split(/\s+/)
);
const wallet = WalletContractV5R1.create({ publicKey, workchain: 0 });
const addrBounce     = wallet.address.toString({ bounceable: true });
const addrNonBounce  = wallet.address.toString({ bounceable: false });
const addrRaw        = wallet.address.toRawString();

// Баланс
const accUrl = `${TON_API_BASE}/v2/blockchain/accounts/${encodeURIComponent(addrBounce)}`;
const acc = await getJson(accUrl);
const balanceNano = BigInt(acc?.balance ?? 0);

// Seqno (надёжно через метод)
let seqno = 0;
try {
  const mUrl = `${TON_API_BASE}/v2/blockchain/accounts/${encodeURIComponent(addrBounce)}/methods/get_seqno`;
  const m = await getJson(mUrl);
  // tonapi может вернуть decoded.seqno ИЛИ stack
  seqno =
    Number(m?.decoded?.seqno ?? m?.decoded?.['0'] ?? m?.data?.seqno ??
      (Array.isArray(m?.stack) && m.stack.length
        ? Number(m.stack[0]?.[1]) // [[num, "123"]]
        : 0)) || 0;
} catch {
  // иногда seqno бывает в accounts.data.seqno
  seqno = Number(acc?.data?.seqno ?? 0) || 0;
}

// Вывод базовой инфы
console.log('Address (bounce)    :', addrBounce);
console.log('Address (non-bounce):', addrNonBounce);
console.log('Address (raw)       :', addrRaw);
console.log('Balance             :', fmtTON(balanceNano));
console.log('Seqno               :', seqno);

// Сверка с pending-tx.json (если есть)
const pending = await readPendingSafe();
if (!pending) {
  console.log(`\nNo pending file at ${PENDING_PATH}`);
  process.exit(0);
}

console.log(`\nFound ${PENDING_PATH}  state=${pending.state}`);
const tx = pending.transaction;
if (!tx?.messages?.length) {
  console.log('No transaction/messages inside pending file.');
  process.exit(0);
}

// from-сравнение
if (tx.from) {
  try {
    const fromAddr = parseAnyAddress(tx.from);
    const match = fromAddr.equals(wallet.address);
    console.log('Tx.from matches wallet   :', match ? '✅ YES' : '⚠️ NO');
    if (!match) {
      console.log('  pending.from =', tx.from);
      console.log('  wallet       =', addrBounce);
    }
  } catch {
    console.log('Could not parse tx.from, skipping compare');
  }
} else {
  console.log('Tx.from is not set (ok for some fragments).');
}

// сумма к отправке
const total = (tx.messages || []).reduce((acc, m) => acc + BigInt(m.amount || 0), 0n);
console.log('Tx messages count        :', tx.messages.length);
console.log('Total to send            :', fmtTON(total));

if (tx.validUntil) {
  const now = Math.floor(Date.now()/1000);
  const left = tx.validUntil - now;
  console.log('validUntil               :', tx.validUntil, left > 0 ? `(~${Math.floor(left/60)}m ${left%60}s left)` : '(EXPIRED)');
}

// грубая проверка запаса на комиссию
const FEE_RESERVE = 50_000_000n; // ~0.05 TON
const enough = balanceNano > (total + FEE_RESERVE);
console.log('Balance sufficient (+fee):', enough ? '✅ YES' : '⚠️ NO');
if (!enough) {
  console.log('  Need at least ≈', fmtTON(total + FEE_RESERVE), 'on balance.');
}
