import express from 'express';
import fetch from 'node-fetch';
import qrcode from 'qrcode-terminal';
import wweb from 'whatsapp-web.js';
const { Client, LocalAuth } = wweb;

const app = express();
app.use(express.json());

// Config
const PORT = process.env.PORT || 3085;
const API_BASE = process.env.API_BASE || 'http://localhost';
const API_TOKEN = process.env.API_TOKEN || '';

// WhatsApp Client
const waClient = new Client({
  authStrategy: new LocalAuth({ clientId: 'sirh-wa' }),
  puppeteer: {
    headless: true,
    // If you have Chrome installed locally, set CHROME_PATH env to its exe
    executablePath: process.env.CHROME_PATH, // e.g. C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

let waReady = false;
let lastQr = null;

waClient.on('qr', (qr) => {
  lastQr = qr;
  console.log('[WA] Scan this QR code to login:');
  qrcode.generate(qr, { small: true });
});

waClient.on('ready', () => {
  waReady = true;
  lastQr = null;
  console.log('[WA] Client is ready');
});

waClient.on('auth_failure', (msg) => {
  console.error('[WA] Auth failure:', msg);
});

waClient.on('disconnected', (reason) => {
  waReady = false;
  console.warn('[WA] Disconnected:', reason);
});

await waClient.initialize();

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Status + QR
app.get('/status', (_req, res) => {
  res.json({ ready: waReady, hasQr: !!lastQr });
});

app.get('/qr', (_req, res) => {
  if (!lastQr) return res.status(404).json({ error: 'no_qr' });
  res.json({ qr: lastQr });
});

// Helper to render a template by calling backend API
async function renderTemplate(templateKey, params) {
  // Adjust this endpoint to your Laravel template rendering route
  const url = `${API_BASE}/api/templates/render`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {})
    },
    body: JSON.stringify({ key: templateKey, params })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API render failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  // Expecting { text: '...' }
  return data.text || '';
}

// Normalize Moroccan numbers etc., add country code if missing
function normalizePhone(phone) {
  let p = (phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('212')) p = '212' + p;
  return p;
}

// Send plain text
app.post('/send-text', async (req, res) => {
  try {
    const { phone, text } = req.body || {};
    if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
    const jid = `${normalizePhone(phone)}@c.us`;
    const message = await waClient.sendMessage(jid, text);
    res.json({ ok: true, id: message.id._serialized });
  } catch (e) {
    console.error('[WA] send-text error', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Send template rendered by API
app.post('/send-template', async (req, res) => {
  try {
    const { phone, templateKey, params } = req.body || {};
    if (!phone || !templateKey) return res.status(400).json({ error: 'phone and templateKey are required' });
    const text = await renderTemplate(templateKey, params || {});
    const jid = `${normalizePhone(phone)}@c.us`;
    const message = await waClient.sendMessage(jid, text);
    res.json({ ok: true, id: message.id._serialized });
  } catch (e) {
    console.error('[WA] send-template error', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[WA] Service listening on :${PORT}`);
});
