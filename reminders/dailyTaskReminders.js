'use strict';

const { DateTime } = require('luxon');

function getTodayDateString(tz) {
  return DateTime.now().setZone(tz).toISODate(); // YYYY-MM-DD
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeReminderText(row) {
  const fullName = [row.prenom, row.name].filter(Boolean).join(' ').trim() || 'Bonjour';
  const start = row.effective_start || row.start_date || '';
  const end = row.effective_end || row.end_date || '';
  const pct = row.pourcentage ?? 0;
  const label = row.description || row.title || '';

  return [
    `Bonjour ${fullName},`,
    `Rappel: vous avez une tâche en cours dans le SIRH.`,
    `- Tâche #${row.id}: ${label}`,
    start || end ? `- Période: ${start || '—'} → ${end || '—'}` : null,
    `- Statut: ${row.status} | Progression: ${pct}%`,
  ].filter(Boolean).join('\n');
}

async function fetchTasksToRemindFromApi({ apiBase, apiKey, today, tz, onlyEnvoyerAuto }) {
  const base = (apiBase || '').replace(/\/$/, '');
  if (!base) throw new Error('REMINDER_API_BASE not configured');

  const url = `${base}/reminders/daily-tasks?date=${encodeURIComponent(today)}&tz=${encodeURIComponent(tz)}&onlyEnvoyerAuto=${onlyEnvoyerAuto ? 'true' : 'false'}`;
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  const resp = await fetch(url, { method: 'GET', headers });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Reminders API failed ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchTasksToRemind(pool, today, { onlyEnvoyerAuto }) {
  const whereAuto = onlyEnvoyerAuto ? 'AND t.envoyer_auto = 1' : '';

  const sql = `
    SELECT
      t.id,
      t.description,
      t.status,
      t.pourcentage,
      t.start_date,
      t.end_date,
      COALESCE(t.start_date, t.date_debut_prevu) AS effective_start,
      COALESCE(t.end_date, t.date_fin_prevu) AS effective_end,
      u.name,
      u.prenom,
      u.tel
    FROM todo_tasks t
    JOIN users u ON u.id = t.assigned_to
    WHERE
      t.assigned_to IS NOT NULL
      AND u.tel IS NOT NULL
      AND TRIM(u.tel) <> ''
      AND COALESCE(t.start_date, t.date_debut_prevu) IS NOT NULL
      AND COALESCE(t.end_date, t.date_fin_prevu) IS NOT NULL
      AND COALESCE(t.start_date, t.date_debut_prevu) <= ?
      AND COALESCE(t.end_date, t.date_fin_prevu) >= ?
      AND t.status <> 'Terminée'
      AND (t.pourcentage IS NULL OR t.pourcentage < 100)
      ${whereAuto}
    ORDER BY u.id, t.id
  `;

  const [rows] = await pool.query(sql, [today, today]);
  return rows;
}

async function runDailyTaskReminders({
  client,
  pool,
  normalizeToJid,
  isWaConnected,
  tz,
  onlyEnvoyerAuto,
  sendDelayMs,
  logger = console,
}) {
  const today = getTodayDateString(tz);

  if (!isWaConnected()) {
    logger.warn(`[reminders] WA not connected; skip (today=${today})`);
    return { ok: false, skipped: true, reason: 'wa_not_connected', today };
  }

  const tasks = await fetchTasksToRemind(pool, today, { onlyEnvoyerAuto });
  logger.log(`[reminders] tasks to remind=${tasks.length} (today=${today})`);

  let sent = 0;
  let failed = 0;

  for (const row of tasks) {
    try {
      const jid = normalizeToJid(row.tel);
      const text = makeReminderText(row);
      await client.sendMessage(jid, text);
      sent++;
      if (sendDelayMs) await sleep(sendDelayMs);
    } catch (e) {
      failed++;
      logger.error(`[reminders] send failed taskId=${row.id} userTel=${row.tel} err=${e?.message || e}`);
    }
  }

  return { ok: true, today, total: tasks.length, sent, failed };
}

async function runDailyTaskRemindersViaApi({
  client,
  apiBase,
  apiKey,
  normalizeToJid,
  isWaConnected,
  tz,
  onlyEnvoyerAuto,
  sendDelayMs,
  logger = console,
}) {
  const today = getTodayDateString(tz);

  if (!isWaConnected()) {
    logger.warn(`[reminders] WA not connected; skip (today=${today})`);
    return { ok: false, skipped: true, reason: 'wa_not_connected', today };
  }

  const tasks = await fetchTasksToRemindFromApi({ apiBase, apiKey, today, tz, onlyEnvoyerAuto });
  logger.log(`[reminders] tasks to remind=${tasks.length} (today=${today}) [source=api]`);

  let sent = 0;
  let failed = 0;

  for (const row of tasks) {
    try {
      const jid = normalizeToJid(row.tel);
      const text = makeReminderText(row);
      await client.sendMessage(jid, text);
      sent++;
      if (sendDelayMs) await sleep(sendDelayMs);
    } catch (e) {
      failed++;
      logger.error(`[reminders] send failed taskId=${row.id} userTel=${row.tel} err=${e?.message || e}`);
    }
  }

  return { ok: true, today, total: tasks.length, sent, failed, source: 'api' };
}

module.exports = { runDailyTaskReminders, runDailyTaskRemindersViaApi };
