// scripts/wallet.js — v5R1: deploy / selftest / send pending-tx  (testnet-ready)
import 'dotenv/config';
import fs from 'fs/promises';
import { TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { Address, Cell } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

const need = k => { if (!process.env[k]) throw new Error(`Missing env: ${k}`); };
need('WALLET_MNEMONIC');

const RPC_ENDPOINT = process.env.TON_RPC_ENDPOINT || 'https://testnet.toncenter.com/api/v2/jsonRPC';
const RPC_KEY = process.env.TON_RPC_API_KEY || undefined;

const client = new TonClient({ endpoint: RPC_ENDPOINT, apiKey: RPC_KEY });

const { publicKey, secretKey } = await mnemonicToPrivateKey(
  process.env.WALLET_MNEMONIC.trim().split(/\s+/)
);
const wallet = WalletContractV5R1.create({ publicKey, workchain: 0 });
const opened = client.open(wallet);

const arg = process.argv[2]; // '--deploy' | '--selftest' | <pending-tx.json>

async function getSeqnoSafe() {
  try { return await opened.getSeqno(); } catch { return 0; }
}

async function ensureDeployed() {
  let seqno = await getSeqnoSafe();
  if (seqno > 0) return seqno;

  console.log('[wallet] Not active → deploying via sendTransfer (self)…');
  // деплой кошелька = обычная исходящая передача (с stateInit прикрепится автоматически)
  await opened.sendTransfer({
    seqno,                 // для первого раза это 0
    secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: Address.parse(wallet.address.toString()), // себе
        value: BigInt(Math.floor(0.02 * 1e9)),        // 0.02 TON хватит на газ в testnet
        body: new Cell(),                             // пустое тело ок
      })
    ],
  });

  // ждём, пока seqno появится
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise(r => setTimeout(r, 1500));
    seqno = await getSeqnoSafe();
    if (seqno > 0) {
      console.log('[wallet] Deployed. Seqno:', seqno);
      return seqno;
    }
  }
  throw new Error('deploy not visible yet — try again in 10–30s');
}

function b64ToCell(b64) {
  return Cell.fromBoc(Buffer.from(b64, 'base64'))[0];
}

async function selftest() {
  const from = wallet.address.toString({ bounceable: true });
  let seqno = await ensureDeployed();
  console.log('From:', from, 'Seqno:', seqno);

  await opened.sendTransfer({
    seqno,
    secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: Address.parse(from),
        value: BigInt(Math.floor(0.005 * 1e9)), // 0.005 TON
      })
    ],
  });
  console.log('✅ Self-test sent.');
}

async function sendPending(path) {
  const data = JSON.parse(await fs.readFile(path, 'utf8'));
  const m = data?.messages?.[0];
  if (!m) throw new Error('pending-tx.json has no messages[0]');

  let seqno = await ensureDeployed();

  const to = Address.parse(m.to);
  const value = BigInt(m.amount); // НАНОТОНЫ
  const body = m.payload ? b64ToCell(m.payload) : undefined;
  const init = m.stateInit ? b64ToCell(m.stateInit) : undefined;

  await opened.sendTransfer({
    seqno,
    secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [ internal({ to, value, body, init }) ],
  });
  console.log('✅ Pending tx sent.');
}

// ---------- CLI ----------
if (!arg) {
  console.log('Usage:');
  console.log('  node -r dotenv/config ./scripts/wallet.js --deploy');
  console.log('  node -r dotenv/config ./scripts/wallet.js --selftest');
  console.log('  node -r dotenv/config ./scripts/wallet.js ./logs/pending-tx.json');
  process.exit(1);
}

if (arg === '--deploy') {
  await ensureDeployed();
  console.log('✅ Wallet is deployed.');
  process.exit(0);
}

if (arg === '--selftest') {
  await selftest();
  process.exit(0);
}

// иначе считаем, что это путь к pending-tx.json
await sendPending(arg);
