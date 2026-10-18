const express = require('express');
const { all } = require('../database/db');
const reminderRepo = require('../database/reminderRepo');
const userRepo = require('../database/userRepo');

function createWebAdapter(assistant) {
  const router = express.Router();
  // Map of active SSE connections: userId -> Set<res>
  const activeClients = new Map();

  // Register 'web' channel dispatcher with core assistant
  assistant.registerChannel('web', async (userId, reply) => {
    const clients = activeClients.get(userId);
    if (clients && clients.size > 0) {
      const payload = `data: ${JSON.stringify(reply)}\n\n`;
      for (const clientRes of clients) {
        try {
          clientRes.write(payload);
        } catch (e) {
          clients.delete(clientRes);
        }
      }
    }
  });

  // POST /api/message: Process incoming user chat message
  router.post('/message', async (req, res) => {
    try {
      const { userId = 'default_user', text = '', attachment = null } = req.body;
      const normalizedMessage = {
        userId: userId.trim(),
        channel: 'web',
        text: text.trim(),
        attachment,
        timestamp: Date.now()
      };

      const reply = await assistant.processMessage(normalizedMessage);
      res.json({ ok: true, reply });
    } catch (err) {
      console.error('Error processing web message:', err);
      res.status(500).json({
        ok: false,
        reply: { text: `Sorry, an unexpected error occurred: ${err.message}` }
      });
    }
  });

  // GET /api/stream: SSE connection for real-time live reminders & push notifications
  router.get('/stream', async (req, res) => {
    const userId = (req.query.userId || 'default_user').trim();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    if (!activeClients.has(userId)) {
      activeClients.set(userId, new Set());
    }
    const clients = activeClients.get(userId);
    clients.add(res);

    // Send connection established event
    res.write(`data: ${JSON.stringify({ type: 'connected', text: 'SSE Connected' })}\n\n`);

    // Check for missed / unread reminders while away
    try {
      const unread = await reminderRepo.getUnreadNotifications(userId);
      if (unread.length > 0) {
        const ids = [];
        for (const notif of unread) {
          res.write(`data: ${JSON.stringify({ text: notif.text, missed: true })}\n\n`);
          ids.push(notif.id);
        }
        await reminderRepo.markNotificationsDelivered(userId, ids);
      }
    } catch (e) {
      console.error('Error sending unread notifications:', e.message);
    }

    req.on('close', () => {
      clients.delete(res);
      if (clients.size === 0) {
        activeClients.delete(userId);
      }
    });
  });

  // GET /api/export: Direct export download
  router.get('/export', async (req, res) => {
    const userId = (req.query.userId || 'default_user').trim();
    try {
      const data = await userRepo.exportAllUserData(userId);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=assistant_export_${userId}.json`);
      res.send(JSON.stringify(data, null, 2));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/database/records: Return tables and live records for viewer
  router.get('/database/records', async (req, res) => {
    try {
      const userId = (req.query.userId || '').trim();
      const scope = req.query.scope || 'user';

      const tableRows = await all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      const tableNames = tableRows
        .map(t => t.name)
        .filter(n => n !== 'pending_actions');

      const preferredOrder = ['expenses', 'reminders', 'memory_vault', 'categories', 'users', 'notifications'];
      tableNames.sort((a, b) => {
        const ia = preferredOrder.indexOf(a);
        const ib = preferredOrder.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.localeCompare(b);
      });

      const tablesData = {};
      for (const name of tableNames) {
        const columns = await all(`PRAGMA table_info(${name})`);
        const colNames = columns.map(c => c.name);
        let rows = [];

        if (scope === 'user' && userId) {
          if (colNames.includes('user_id')) {
            rows = await all(`SELECT * FROM ${name} WHERE user_id = ? ORDER BY id DESC LIMIT 200`, [userId]);
          } else if (name === 'users') {
            rows = await all(`SELECT * FROM users WHERE id = ?`, [userId]);
          } else {
            rows = await all(`SELECT * FROM ${name} ORDER BY 1 DESC LIMIT 200`);
          }
        } else {
          rows = await all(`SELECT * FROM ${name} ORDER BY 1 DESC LIMIT 200`);
        }

        tablesData[name] = {
          name,
          columns: columns.map(c => ({ name: c.name, type: c.type, pk: c.pk })),
          rows,
          count: rows.length
        };
      }

      res.json({
        ok: true,
        database: 'assistant.db (SQLite)',
        tables: tablesData
      });
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = {
  createWebAdapter
};
