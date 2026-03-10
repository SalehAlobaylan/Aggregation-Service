/**
 * One-time script to generate TELEGRAM_SESSION_STRING.
 * Run: npx tsx src/scripts/telegram-auth.ts
 *
 * Requires TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.
 * You will be prompted for your phone number and the code Telegram sends you.
 * Copy the output session string into your .env as TELEGRAM_SESSION_STRING=...
 */
import 'dotenv/config';
import input from 'input';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : null;
const apiHash = process.env.TELEGRAM_API_HASH || null;

if (!apiId || !apiHash) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env');
  process.exit(1);
}

const stringSession = new StringSession('');
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

async function main() {
  console.log('Telegram session generator for Wahb Aggregation Service');
  console.log('You will need your phone number and a code from Telegram.\n');

  await client.start({
    phoneNumber: async () => await input.text('Enter your phone number (e.g. +966501234567): '),
    phoneCode: async () => await input.text('Enter the code you received from Telegram: '),
    password: async () => await input.text('Enter your 2FA password (if enabled, else press Enter): '),
    onError: (err) => console.error(err),
  });

  const sessionString = client.session.save();
  await client.disconnect();

  console.log('\n' + '='.repeat(60));
  console.log('SUCCESS! Add this to your .env or .env.local:');
  console.log('='.repeat(60));
  console.log(`TELEGRAM_SESSION_STRING=${sessionString}`);
  console.log('='.repeat(60));
  console.log('\nRestart the Aggregation Service after adding the variable.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
