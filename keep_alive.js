// ============================================================
// Habesha Bingo & Telegram Bot - 24/7 Keep-Alive Daemon
// ============================================================
// Render Free tier shuts down after 15 minutes of inactivity.
// This daemon continuously pings the backend every 4 minutes,
// ensuring the server and Telegram Bot stay 100% active 24/7.
// ============================================================

const TARGET_URL = process.env.PUBLIC_APP_URL || 'https://habesha-bingo-1-3jdi.onrender.com';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8608274368:AAE_kGjR_P61Ev2BQPbLgTdvoBYPyAJ1bPg';
const PING_INTERVAL_MS = 4 * 60 * 1000; // Ping every 4 minutes

console.log('='.repeat(65));
console.log('🚀 Habesha Bingo & Telegram Bot 24/7 Keep-Alive Daemon Started');
console.log(`🎯 Target API: ${TARGET_URL}`);
console.log(`⏱️ Interval: Every 4 minutes`);
console.log('='.repeat(65));

async function pingBackend() {
  const timestamp = new Date().toLocaleTimeString();
  try {
    const healthUrl = `${TARGET_URL.replace(/\/$/, '')}/api/health`;
    const res = await fetch(healthUrl, {
      headers: { 'User-Agent': 'HabeshaBingo-KeepAlive-Daemon/1.0' }
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      console.log(`[${timestamp}] ✅ Backend API ALIVE (status ${res.status}):`, JSON.stringify(data));
    } else {
      console.warn(`[${timestamp}] ⚠️ Backend returned status ${res.status}`);
    }
  } catch (err) {
    console.error(`[${timestamp}] ❌ Ping failed:`, err.message);
  }
}

async function verifyBotWebhook() {
  const timestamp = new Date().toLocaleTimeString();
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    const data = await res.json().catch(() => ({}));
    if (data && data.ok) {
      const info = data.result;
      const expectedWebhook = `${TARGET_URL.replace(/\/$/, '')}/api/telegram/webhook`;
      if (info.url === expectedWebhook) {
        console.log(`[${timestamp}] 🤖 Telegram Webhook ACTIVE & CONNECTED: ${info.url}`);
      } else {
        console.warn(`[${timestamp}] ⚠️ Telegram Webhook missing or altered (${info.url}). Reconnecting...`);
        const setRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: expectedWebhook,
            secret_token: 'habeshabingo_secret_2026',
            max_connections: 40
          })
        });
        const setData = await setRes.json().catch(() => ({}));
        console.log(`[${timestamp}] 🤖 Webhook re-registration result:`, setData);
      }
    }
  } catch (bErr) {
    console.warn(`[${timestamp}] ⚠️ Bot check warning:`, bErr.message);
  }
}

async function runCycle() {
  await pingBackend();
  await verifyBotWebhook();
}

// Run initial ping immediately
runCycle();

// Repeat every 4 minutes
setInterval(runCycle, PING_INTERVAL_MS);
