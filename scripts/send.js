// scripts/send.js
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { TonClient, WalletContractV4, WalletContractV5R1, internal, Address, Cell } from '@ton/ton';
import { mnemonicToWalletKey, mnemonicToPrivateKey } from '@ton/crypto';
import { getHttpEndpoint } from '@orbs-network/ton-access';

const PENDING_PATH      = process.env.PENDING_PATH || './logs/pending-tx.json';
const SEQNO_LOCK_PATH   = process.env.SEQNO_LOCK_PATH || './logs/seqno.lock';
const MNEMONIC          = process.env.MNEMONIC || process.env.WALLET_MNEMONIC;
const WALLET_VERSION    = (process.env.WALLET_VERSION || 'v5r1').toLowerCase();
const TON_ENDPOINT      = process.env.TON_ENDPOINT || '';
const CONFIRM_TIMEOUT_MS= Number(process.env.CONFIRM_TIMEOUT_MS || 180_000);

if (!MNEMONIC) { console.error('ERROR: MNEMONIC not set'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

async function readJSON(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }
async function ensureDir(p){ try{ await fs.mkdir(path.dirname(p), { recursive:true }); }catch{} }

async function readLock() {
  try { return Number((await fs.readFile(SEQNO_LOCK_PATH, 'utf8')).toString().trim()); }
  catch { return null; }
}
async function writeLock(n) {
  await ensureDir(SEQNO_LOCK_PATH);
  await fs.writeFile(SEQNO_LOCK_PATH, String(n));
  console.log('lock →', SEQNO_LOCK_PATH, ' = ', n);
}

async function makeClient() {
  const endpoint = TON_ENDPOINT || await getHttpEndpoint({ network: 'mainnet' });
  return new TonClient({ endpoint });
}
async function makeWallet() {
  const words = MNEMONIC.trim().split(/\s+/);
  if (WALLET_VERSION === 'v4') {
    const kp = await mnemonicToWalletKey(words);
    return { wallet: WalletContractV4.create({ publicKey: kp.publicKey, workchain: 0 }), secretKey: kp.secretKey, version: 'v4' };
  }
  const kp = await mnemonicToPrivateKey(words);
  return { wallet: WalletContractV5R1.create({ publicKey: kp.publicKey, workchain: 0 }), secretKey: kp.secretKey, version: 'v5r1' };
}

async function main() {
  try {
    const pending = await readJSON(PENDING_PATH);
    if (pending.state !== 'ready') throw new Error(`pending state = ${pending.state}`);
    const tx = pending.transaction;
    if (!tx?.messages?.length) throw new Error('No messages');
    if (tx.validUntil && nowSec() > tx.validUntil) throw new Error('Transaction expired');

    const client = await makeClient();
    const { wallet, secretKey, version } = await makeWallet();
    const opened = client.open(wallet);

    const currentSeqno = await opened.getSeqno().catch(() => 0);
    console.log('Wallet version:', version);
    console.log('Wallet address:', wallet.address.toString({ testOnly: false }));
    console.log('Seqno (current):', currentSeqno);

    const lastTried = await readLock();
    console.log('lock ←', SEQNO_LOCK_PATH, ' = ', lastTried);
    if (lastTried != null && currentSeqno > lastTried) {
      console.log('✅ already confirmed earlier (seqno advanced). Skip resend.');
      process.exit(0);
    }

    const messages = tx.messages.map(m => internal({
      to: Address.parse(m.address),
      value: BigInt(m.amount),
      body: m.payload ? Cell.fromBase64(m.payload) : undefined,
      bounce: true,
    }));

    // === добавлен умный ретрай на 429 ===
    const MAX_RETRIES = 6;
    const BASE_DELAY  = 3000;   // 3 секунды
    const MAX_DELAY   = 30000;  // максимум 30 сек

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        await opened.sendTransfer({ seqno: currentSeqno, secretKey, messages, sendMode: 3 });
        console.log('✅ sent, waiting for confirmation…');
        await writeLock(currentSeqno);
        break;
      } catch (e) {
        const msg = `${e?.message || ''}`.toLowerCase();
        if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate')) {
          const delay = Math.min(MAX_DELAY, BASE_DELAY * Math.pow(2, i));
          console.warn(`[send][429] retry ${i + 1}/${MAX_RETRIES} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw e;
      }
    }

    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(1500);
      const s = await opened.getSeqno().catch(() => currentSeqno);
      if (s > currentSeqno) {
        console.log('✅ confirmed, new seqno =', s);
        await writeLock(s);
        process.exit(0);
      }
    }
    console.log('⏱️ confirmation timeout (tx likely pending)');
    process.exit(2);
  } catch (e) {
    console.error('ERROR:', e?.message || e);
    process.exit(1);
  }
}
main();