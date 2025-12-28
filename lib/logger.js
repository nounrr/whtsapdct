'use strict';

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const REMINDER_LOGS_FILE = path.join(LOG_DIR, 'reminders.json');

// Créer le dossier logs s'il n'existe pas
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Enregistre un log de reminder
 * @param {Object} logData - Les données du log
 * @param {string} logData.type - Type de log: 'reminder_start', 'reminder_success', 'reminder_error', 'reminder_complete'
 * @param {string} logData.date - Date du log (ISO format)
 * @param {Object} logData.request - La requête (tasks à envoyer)
 * @param {Object} logData.response - La réponse (résultats)
 * @param {string} [logData.error] - Message d'erreur si applicable
 */
function logReminder(logData) {
  try {
    const timestamp = DateTime.now().setZone('Africa/Casablanca').toISO();
    
    const logEntry = {
      timestamp,
      type: logData.type || 'info',
      date: logData.date || timestamp,
      request: logData.request || null,
      response: logData.response || null,
      error: logData.error || null,
    };

    // Lire les logs existants
    let logs = [];
    if (fs.existsSync(REMINDER_LOGS_FILE)) {
      try {
        const content = fs.readFileSync(REMINDER_LOGS_FILE, 'utf8');
        logs = JSON.parse(content);
      } catch (e) {
        console.warn('[logger] Erreur lecture logs existants:', e.message);
        logs = [];
      }
    }

    // Ajouter le nouveau log
    logs.push(logEntry);

    // Limiter à 1000 logs (garder les 1000 plus récents)
    if (logs.length > 1000) {
      logs = logs.slice(-1000);
    }

    // Écrire les logs
    fs.writeFileSync(REMINDER_LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
    
    return logEntry;
  } catch (e) {
    console.error('[logger] Erreur écriture log:', e);
    return null;
  }
}

/**
 * Récupère les logs
 * @param {Object} options - Options de filtrage
 * @param {number} [options.limit] - Nombre maximum de logs à retourner
 * @param {string} [options.type] - Filtrer par type de log
 * @param {string} [options.date] - Filtrer par date (YYYY-MM-DD)
 * @returns {Array} Liste des logs
 */
function getLogs(options = {}) {
  try {
    if (!fs.existsSync(REMINDER_LOGS_FILE)) {
      return [];
    }

    const content = fs.readFileSync(REMINDER_LOGS_FILE, 'utf8');
    let logs = JSON.parse(content);

    // Filtrer par type
    if (options.type) {
      logs = logs.filter(log => log.type === options.type);
    }

    // Filtrer par date
    if (options.date) {
      logs = logs.filter(log => {
        const logDate = DateTime.fromISO(log.timestamp).toISODate();
        return logDate === options.date;
      });
    }

    // Limiter le nombre de résultats (les plus récents)
    if (options.limit) {
      logs = logs.slice(-options.limit);
    }

    // Retourner dans l'ordre inverse (plus récent en premier)
    return logs.reverse();
  } catch (e) {
    console.error('[logger] Erreur lecture logs:', e);
    return [];
  }
}

/**
 * Supprime tous les logs
 */
function clearLogs() {
  try {
    if (fs.existsSync(REMINDER_LOGS_FILE)) {
      fs.unlinkSync(REMINDER_LOGS_FILE);
      return true;
    }
    return false;
  } catch (e) {
    console.error('[logger] Erreur suppression logs:', e);
    return false;
  }
}

/**
 * Obtient les statistiques des logs
 * @param {Object} whatsappClient - Client WhatsApp (optionnel)
 */
async function getLogsStats(whatsappClient = null) {
  try {
    const logs = getLogs();
    
    const today = DateTime.now().setZone('Africa/Casablanca').toISODate();
    const todayLogs = logs.filter(log => {
      const logDate = DateTime.fromISO(log.timestamp).toISODate();
      return logDate === today;
    });

    // Calculer le nombre total de messages envoyés (succès) depuis les logs
    const totalMessagesSent = logs.filter(log => log.type === 'reminder_success').length;
    const todayMessagesSent = todayLogs.filter(log => log.type === 'reminder_success').length;

    // Calculer les erreurs
    const totalErrors = logs.filter(log => log.type === 'reminder_error').length;
    const todayErrors = todayLogs.filter(log => log.type === 'reminder_error').length;

    const stats = {
      total: logs.length,
      today: todayLogs.length,
      messagesSent: totalMessagesSent,
      todayMessagesSent: todayMessagesSent,
      totalErrors: totalErrors,
      todayErrors: todayErrors,
      byType: {},
      lastLog: logs.length > 0 ? logs[0] : null
    };

    // Récupérer les statistiques depuis le client WhatsApp si disponible
    // Compte TOUS les messages (reminders auto, manuels, etc.)
    if (whatsappClient) {
      try {
        const chats = await whatsappClient.getChats();
        let allMessagesSent = 0;
        let allMessagesSentToday = 0;

        const todayStart = DateTime.now().setZone('Africa/Casablanca').startOf('day').toMillis() / 1000;

        // Compter TOUS les messages envoyés dans tous les chats
        for (const chat of chats) {
          try {
            // Récupérer les messages du chat (limité pour performance)
            const messages = await chat.fetchMessages({ limit: 1000 });
            
            // Filtrer les messages envoyés par nous (fromMe = true) et qui ne sont PAS en erreur
            const sentByMe = messages.filter(msg => {
              return msg.fromMe && 
                     msg.ack !== -1 && // Exclure messages échoués
                     msg.type !== 'revoked' && // Exclure messages révoqués
                     !msg.isStatus; // Exclure les statuts WhatsApp
            });
            
            allMessagesSent += sentByMe.length;

            // Compter ceux envoyés aujourd'hui
            const todaySent = sentByMe.filter(msg => msg.timestamp >= todayStart);
            allMessagesSentToday += todaySent.length;
          } catch (chatErr) {
            console.warn(`[logger] Erreur lecture chat ${chat.id._serialized}:`, chatErr.message);
          }
        }

        // Stats globales depuis WhatsApp (TOUS les messages)
        stats.allMessagesSent = allMessagesSent;
        stats.allMessagesSentToday = allMessagesSentToday;
        stats.totalChats = chats.length;
      } catch (waErr) {
        console.warn('[logger] Erreur récupération stats WhatsApp:', waErr.message);
        stats.waError = waErr.message;
      }
    }

    logs.forEach(log => {
      const type = log.type || 'unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    });

    return stats;
  } catch (e) {
    console.error('[logger] Erreur calcul stats:', e);
    return null;
  }
}

/**
 * Récupère la liste des messages envoyés avec détails
 * @param {Object} options - Options de filtrage
 * @param {number} [options.limit] - Nombre maximum de messages à retourner
 * @param {string} [options.date] - Filtrer par date (YYYY-MM-DD)
 * @returns {Array} Liste des messages envoyés
 */
function getSentMessages(options = {}) {
  try {
    if (!fs.existsSync(REMINDER_LOGS_FILE)) {
      return [];
    }

    const content = fs.readFileSync(REMINDER_LOGS_FILE, 'utf8');
    let logs = JSON.parse(content);

    // Filtrer uniquement les messages envoyés avec succès
    let messages = logs.filter(log => log.type === 'reminder_success');

    // Filtrer par date si spécifié
    if (options.date) {
      messages = messages.filter(log => {
        const logDate = DateTime.fromISO(log.timestamp).toISODate();
        return logDate === options.date;
      });
    }

    // Transformer pour extraire les infos importantes
    const result = messages.map(log => {
      const timestamp = log.timestamp;
      const tel = log.request?.tel || 'Inconnu';
      const taskId = log.request?.taskId || null;
      const message = log.request?.message || '';
      const jid = log.response?.jid || null;

      return {
        timestamp,
        date: DateTime.fromISO(timestamp).toFormat('dd/MM/yyyy HH:mm:ss'),
        tel,
        taskId,
        message,
        jid
      };
    });

    // Limiter le nombre de résultats (les plus récents)
    if (options.limit) {
      return result.slice(-options.limit).reverse();
    }

    // Retourner dans l'ordre inverse (plus récent en premier)
    return result.reverse();
  } catch (e) {
    console.error('[logger] Erreur récupération messages envoyés:', e);
    return [];
  }
}

module.exports = {
  logReminder,
  getLogs,
  getSentMessages,
  clearLogs,
  getLogsStats,
  LOG_DIR,
  REMINDER_LOGS_FILE
};
