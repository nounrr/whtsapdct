const path = require('path');

// Load environment variables from .env (use absolute path so it works under PM2/systemd)
const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '.env') });
if (dotenvResult?.error) {
  console.warn('[config] .env not loaded:', dotenvResult.error.message);
}

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcodeTerminal = require('qrcode-terminal');
const cron = require('node-cron');

const { createPoolFromEnv } = require('./lib/db');
const { runDailyTaskReminders, runDailyTaskRemindersViaApi } = require('./reminders/dailyTaskReminders');
const { getLogs, getSentMessages, clearLogs, getLogsStats, backfillOldRemindersFromWhatsApp } = require('./lib/logger');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Security: simple API key protection for send endpoints
const API_KEY = process.env.WA_API_KEY || null;

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'api_key_not_configured' });
  const provided = req.get('x-api-key');
  if (!provided || provided !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    // If Chrome is installed locally, you can set CHROME_PATH env to its executable
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  }
});

const REMINDER_SOURCE = (process.env.REMINDER_SOURCE || 'db').toLowerCase(); // 'db' | 'api'

// DB pool (SIRH back database)
let dbPool = null;
if (REMINDER_SOURCE !== 'api') {
  try {
    dbPool = createPoolFromEnv();
    console.log('[db] MySQL pool created');
  } catch (e) {
    console.warn('[db] Not configured, reminders disabled until DB_* env vars are set:', e?.message);
  }
}

let isClientReady = false;
let lastQr = null;
let lastState = 'INIT';
let lastReadyAt = null;
let reinitTimer = null;
function scheduleReinit(delayMs = 3000) {
  if (reinitTimer) return;
  reinitTimer = setTimeout(() => {
    reinitTimer = null;
    try {
      console.log('Reinitialisation du client WhatsApp...');
      client.initialize();
    } catch (e) {
      console.warn('Erreur lors de la réinitialisation:', e?.message);
    }
  }, delayMs);
}

// CORS (allow calls from frontend)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

client.on('qr', (qr) => {
  console.log('QR Code généré');
  isClientReady = false;
  lastQr = qr;
  try {
    console.log('Scanne ce QR avec WhatsApp > Appareils liés (Linked devices):');
    qrcodeTerminal.generate(qr, { small: true });
  } catch (e) {
    console.warn('Impossible d\'afficher le QR en ASCII:', e?.message);
  }
  io.emit('qr', qr);
});

client.on('ready', () => {
  console.log('Client prêt ✅');
  isClientReady = true;
  lastState = 'CONNECTED';
  lastReadyAt = Date.now();
  io.emit('ready');
});

client.on('authenticated', () => {
  console.log('Authentifié ✅');
  io.emit('authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('Erreur d\'authentification :', msg);
  isClientReady = false;
  lastState = 'AUTH_FAILURE';
  io.emit('auth_failure', msg);
  scheduleReinit(5000);
});

client.on('disconnected', (reason) => {
  console.log('Déconnecté :', reason);
  isClientReady = false;
  lastState = 'DISCONNECTED';
  io.emit('disconnected', reason);
  scheduleReinit(3000);
});

client.on('change_state', (state) => {
  lastState = state || lastState;
});

// Gérer les connexions Socket.IO
io.on('connection', (socket) => {
  console.log('Nouveau client connecté');

  // Envoyer l'état actuel du client
  if (isClientReady) {
    socket.emit('ready');
  }

  socket.on('send_message', async ({ phoneNumber, message }) => {
    try {
      // Vérifier que le client est prêt
      if (!isClientReady) {
        socket.emit('message_error', 'Le client WhatsApp n\'est pas encore prêt. Veuillez scanner le QR code.');
        return;
      }

      const chatId = normalizeToJid(phoneNumber);
      
      // Vérifier que le numéro est valide
      const numberId = await client.getNumberId(chatId.replace('@c.us',''));
      if (!numberId) {
        socket.emit('message_error', 'Numéro WhatsApp invalide ou non enregistré');
        return;
      }

      await client.sendMessage(chatId, message);
      console.log('Message envoyé à', phoneNumber);
      socket.emit('message_success', { phoneNumber });
    } catch (err) {
      console.error('Erreur envoi message ❌', err);
      socket.emit('message_error', err.message || 'Erreur lors de l\'envoi du message');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté');
  });
});

// Helpers
function normalizeDigits(p) {
  return (p || '').toString().replace(/\D+/g, '');
}

function normalizePhone(phone) {
  let p = normalizeDigits(phone);
  if (!p) return p;
  // If starts with 0 and DEFAULT_CC is provided, use it (e.g. 212)
  if (p.startsWith('0') && process.env.DEFAULT_CC) {
    p = process.env.DEFAULT_CC.replace(/\D+/g, '') + p.slice(1);
  }
  // If no country code, default to 212 if provided via env or fallback to 212
  if (!p.startsWith('212') && process.env.DEFAULT_CC) {
    const cc = process.env.DEFAULT_CC.replace(/\D+/g, '');
    if (cc && !p.startsWith(cc)) p = cc + p;
  }
  return p;
}

function normalizeToJid(phone) {
  const digits = normalizePhone(phone);
  return `${digits}@c.us`;
}

// Daily reminders
const REMINDER_TZ = process.env.REMINDER_TZ || 'Africa/Casablanca';

// Manual reminder time (HH:mm, 24h). Example: '15:57'
// NOTE: This is intentionally NOT read from .env as requested.
const REMINDER_AT = '16:00';

// Debug: Log effective configuration
console.log('[config] REMINDER_AT (manual):', REMINDER_AT);
console.log('[config] REMINDER_TZ from env:', process.env.REMINDER_TZ);
console.log('[config] REMINDER_CRON from env (optional override):', process.env.REMINDER_CRON);

function cronFromReminderAt(reminderAt) {
  if (!reminderAt) {
    console.log('[config] cronFromReminderAt: reminderAt is empty/null');
    return null;
  }
  const m = String(reminderAt).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) {
    console.log('[config] cronFromReminderAt: invalid format for', reminderAt);
    return null;
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const cron = `${minute} ${hour} * * *`;
  console.log('[config] cronFromReminderAt: converted', reminderAt, 'to', cron);
  return cron;
}

const REMINDER_CRON = process.env.REMINDER_CRON || cronFromReminderAt(REMINDER_AT) || '0 8 * * *';
console.log('[config] Final REMINDER_CRON:', REMINDER_CRON);
const REMINDER_ONLY_ENVOYER_AUTO = (process.env.REMINDER_ONLY_ENVOYER_AUTO || 'true').toLowerCase() !== 'false';
const REMINDER_SEND_DELAY_MS = process.env.REMINDER_SEND_DELAY_MS ? Number(process.env.REMINDER_SEND_DELAY_MS) : 600;
const REMINDER_API_BASE = process.env.REMINDER_API_BASE || null; // e.g. https://example.com/api
const REMINDER_API_KEY = process.env.REMINDER_API_KEY || process.env.TEMPLATE_API_KEY || null;

function isWaConnected() {
  return lastState === 'CONNECTED';
}

if (REMINDER_SOURCE === 'api') {
  if (!REMINDER_API_BASE) {
    console.warn('[reminders] REMINDER_SOURCE=api but REMINDER_API_BASE is missing; reminders disabled');
  } else {
    if (!REMINDER_API_KEY) {
      console.warn('[reminders] REMINDER_SOURCE=api but REMINDER_API_KEY is missing; backend may return 401');
    } else {
      console.log(`[reminders] api auth configured (keyLen=${String(REMINDER_API_KEY).length})`);
    }
    cron.schedule(
      REMINDER_CRON,
      async () => {
        try {
          const result = await runDailyTaskRemindersViaApi({
            client,
            apiBase: REMINDER_API_BASE,
            apiKey: REMINDER_API_KEY,
            normalizeToJid,
            isWaConnected,
            tz: REMINDER_TZ,
            onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
            sendDelayMs: REMINDER_SEND_DELAY_MS,
            logger: console,
          });
          console.log('[reminders] done', result);
        } catch (e) {
          console.error('[reminders] job error', e);
        }
      },
      { timezone: REMINDER_TZ }
    );
    console.log(`[reminders] scheduled cron="${REMINDER_CRON}" tz="${REMINDER_TZ}" source=api onlyEnvoyerAuto=${REMINDER_ONLY_ENVOYER_AUTO}`);
  }
} else if (dbPool) {
  cron.schedule(
    REMINDER_CRON,
    async () => {
      try {
        const result = await runDailyTaskReminders({
          client,
          pool: dbPool,
          normalizeToJid,
          isWaConnected,
          tz: REMINDER_TZ,
          onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
          sendDelayMs: REMINDER_SEND_DELAY_MS,
          logger: console,
        });
        console.log('[reminders] done', result);
      } catch (e) {
        console.error('[reminders] job error', e);
      }
    },
    { timezone: REMINDER_TZ }
  );
  console.log(`[reminders] scheduled cron="${REMINDER_CRON}" tz="${REMINDER_TZ}" source=db onlyEnvoyerAuto=${REMINDER_ONLY_ENVOYER_AUTO}`);
}

// REST endpoints
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/status', async (_req, res) => {
  let state = lastState;
  try {
    state = await client.getState();
  } catch (e) {
    // keep lastState
  }
  res.json({
    ready: isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED'),
    state,
    lastState,
    hasQr: !!lastQr,
    lastReadyAt,
    now: Date.now()
  });
});

app.get('/qr', (_req, res) => {
  if (!lastQr) return res.status(404).json({ error: 'no_qr' });
  res.json({ qr: lastQr });
});

// Send plain text
app.post('/send-text', requireApiKey, async (req, res) => {
  try {
    const { phone, text } = req.body || {};
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
    }
    if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone_and_text_required' });
    const jid = normalizeToJid(phone);
    const msg = await client.sendMessage(jid, text);
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-text error', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Send template rendered by Laravel API
app.post('/send-template', requireApiKey, async (req, res) => {
  try {
    const { phone, templateKey, params } = req.body || {};
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
    }
    if (!phone || !templateKey) return res.status(400).json({ ok: false, error: 'phone_and_templateKey_required' });

    const apiBase = process.env.API_BASE || 'http://localhost';
    const url = `${apiBase.replace(/\/$/, '')}/api/templates/render`;
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.TEMPLATE_API_KEY;
    if (apiKey) headers['X-Api-Key'] = apiKey;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: templateKey, params: params || {} })
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`API render failed ${resp.status} ${t}`);
    }
    const data = await resp.json();
    const text = data?.text || '';
    if (!text) throw new Error('Rendered text empty');

    const jid = normalizeToJid(phone);
    const msg = await client.sendMessage(jid, text);
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-template error', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Endpoints pour les logs
app.get('/api/logs', async (req, res) => {
  try {
    const { limit, type, date } = req.query;
    const options = {};
    
    if (limit) options.limit = parseInt(limit);
    if (type) options.type = type;
    if (date) options.date = date;

    const logs = getLogs(options);
    const statsFull = await getLogsStats(client);
    const messages = getSentMessages({ limit: options.limit || 100, date: options.date });

    const stats = {
      totalErrors: statsFull?.totalErrors || 0,
      todayErrors: statsFull?.todayErrors || 0,
      allMessagesSent: statsFull?.allMessagesSent || 0,
      allMessagesSentToday: statsFull?.allMessagesSentToday || 0,
      totalChats: statsFull?.totalChats || 0,
    };

    res.json({ ok: true, logs, messages, stats });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

app.get('/api/logs/messages', async (req, res) => {
  try {
    const { limit, date } = req.query;
    const options = {};
    
    if (limit) options.limit = parseInt(limit);
    if (date) options.date = date;

    const messages = getSentMessages(options);

    res.json({ ok: true, messages, total: messages.length });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

app.get('/api/logs/stats', async (req, res) => {
  try {
    const statsFull = await getLogsStats(client);
    const stats = {
      totalErrors: statsFull?.totalErrors || 0,
      todayErrors: statsFull?.todayErrors || 0,
      allMessagesSent: statsFull?.allMessagesSent || 0,
      allMessagesSentToday: statsFull?.allMessagesSentToday || 0,
      totalChats: statsFull?.totalChats || 0,
    };
    res.json({ ok: true, stats });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Backfill old reminders from WhatsApp into logs/reminders.json
// Protected (x-api-key) because it reads message history and writes logs.
app.post('/api/logs/backfill-reminders', requireApiKey, async (req, res) => {
  try {
    const sinceDays = req.query.sinceDays ? Number(req.query.sinceDays) : 30;
    const limitPerChat = req.query.limitPerChat ? Number(req.query.limitPerChat) : 1000;
    const maxChats = req.query.maxChats ? Number(req.query.maxChats) : 300;

    const result = await backfillOldRemindersFromWhatsApp({
      client,
      tz: process.env.REMINDER_TZ || 'Africa/Casablanca',
      sinceDays,
      limitPerChat,
      maxChats,
      logger: console,
    });

    res.json({ ok: true, result });
  } catch (e) {
    console.error('[backfill] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

app.delete('/api/logs', requireApiKey, (req, res) => {
  try {
    const result = clearLogs();
    res.json({ ok: true, cleared: result });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Test endpoint to manually trigger reminders
app.post('/api/send-reminder-test', requireApiKey, async (req, res) => {
  try {
    let state = 'UNKNOWN';
    try { state = await client.getState(); } catch (_) {}
    if (!isClientReady || state !== 'CONNECTED') {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, message: 'WhatsApp client is not ready. Please scan QR code first.' });
    }

    console.log('[reminder-test] Manual reminder trigger started...');
    
    let result;
    if (REMINDER_SOURCE === 'api') {
      if (!REMINDER_API_BASE) {
        return res.status(500).json({ ok: false, error: 'REMINDER_API_BASE not configured' });
      }
      result = await runDailyTaskRemindersViaApi({
        client,
        apiBase: REMINDER_API_BASE,
        apiKey: REMINDER_API_KEY,
        normalizeToJid,
        isWaConnected,
        tz: REMINDER_TZ,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
        sendDelayMs: REMINDER_SEND_DELAY_MS,
        logger: console,
      });
    } else if (dbPool) {
      result = await runDailyTaskReminders({
        client,
        pool: dbPool,
        normalizeToJid,
        isWaConnected,
        tz: REMINDER_TZ,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
        sendDelayMs: REMINDER_SEND_DELAY_MS,
        logger: console,
      });
    } else {
      return res.status(500).json({ ok: false, error: 'no_reminder_source_configured' });
    }

    console.log('[reminder-test] Manual reminder completed:', result);
    res.json({ 
      ok: true, 
      result,
      config: {
        source: REMINDER_SOURCE,
        tz: REMINDER_TZ,
        cron: REMINDER_CRON,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO
      }
    });
  } catch (e) {
    console.error('[reminder-test] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown', stack: e?.stack });
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`Serveur démarré sur http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Erreur: le port ${PORT} est déjà utilisé sur ${HOST}.`);
    console.error('Astuce: arrête l\'autre service ou change PORT/HOST.');
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
