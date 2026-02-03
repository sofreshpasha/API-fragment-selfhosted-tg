// scripts/init-wallet.js
import { mnemonicNew, mnemonicValidate, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';

const words = await mnemonicNew(24);
if (!(await mnemonicValidate(words))) throw new Error('mnemonic invalid');

const { publicKey } = await mnemonicToPrivateKey(words);
const wallet = WalletContractV5R1.create({ publicKey, workchain: 0 });

const addrBounce    = wallet.address.toString({ bounceable: true });
const addrNonBounce = wallet.address.toString({ bounceable: false });

console.log('=== SAVE YOUR SEED (do NOT commit) ===\n');
console.log('WALLET_MNEMONIC="' + words.join(' ') + '"\n');
console.log('Address (bounceable)    :', addrBounce);
console.log('Address (non-bounceable):', addrNonBounce);
console.log('\nДобавь эту строку WALLET_MNEMONIC в .env руками.');
