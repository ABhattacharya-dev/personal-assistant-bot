const express = require('express');
const { all } = require('../database/db');
const reminderRepo = require('../database/reminderRepo');
const userRepo = require('../database/userRepo');
const cognitoService = require('../services/cognitoService');

function createWebAdapter(assistant) {
  const router = express.Router();
  // Map of active SSE connections: userId -> Set<res>
  const activeClients = new Map();

  // Helper to extract authenticated user from Bearer token or token query param
  async function resolveUserFromReq(req) {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.query && req.query.token) {
      token = String(req.query.token).trim();
    }

    if (token) {
      try {
        const cognitoUser = await cognitoService.getUser(token);
        if (cognitoUser && cognitoUser.id) {
          await userRepo.ensureUser(cognitoUser.id, 'Asia/Kolkata', {
            email: cognitoUser.email,
            name: cognitoUser.name,
            tone: cognitoUser.tone,
            system_prompt: cognitoUser.customPrompt
          });
          return cognitoUser;
        }
      } catch (err) {
        // Token invalid or expired
      }
    }
    return null;
  }

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

  // --- AUTHENTICATION & PROFILE ROUTES (AWS COGNITO) ---

  // POST /api/auth/signup: Register via Cognito
  router.post('/auth/signup', async (req, res) => {
    try {
      const { email, password, name = '', tone = 'friendly', customPrompt = '' } = req.body;
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Email and password are required.' });
      }

      const result = await cognitoService.signUp({ email, password, name, tone, customPrompt });
      // Create local user record in SQLite
      await userRepo.ensureUser(result.userSub, 'Asia/Kolkata', {
        email,
        name,
        tone,
        system_prompt: customPrompt
      });

      res.json({
        ok: true,
        message: 'Account registered successfully.',
        userSub: result.userSub
      });
    } catch (err) {
      console.error('[Auth SignUp Error]:', err.message);
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // POST /api/auth/login: Authenticate via Cognito
  router.post('/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Email and password are required.' });
      }

      const authData = await cognitoService.login({ email, password });
      // Sync into SQLite
      await userRepo.ensureUser(authData.user.id, 'Asia/Kolkata', {
        email: authData.user.email,
        name: authData.user.name,
        tone: authData.user.tone,
        system_prompt: authData.user.customPrompt
      });

      res.json({
        ok: true,
        accessToken: authData.accessToken,
        idToken: authData.idToken,
        user: authData.user
      });
    } catch (err) {
      console.error('[Auth Login Error]:', err.message);
      res.status(401).json({ ok: false, error: err.message || 'Invalid credentials' });
    }
  });

  // GET /api/auth/profile: Fetch current user profile
  router.get('/auth/profile', async (req, res) => {
    try {
      const cognitoUser = await resolveUserFromReq(req);
      if (!cognitoUser) {
        return res.status(401).json({ ok: false, error: 'Authentication required. Please sign in.' });
      }

      const localUser = await userRepo.getUser(cognitoUser.id);
      res.json({
        ok: true,
        user: {
          ...cognitoUser,
          ...localUser
        }
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/auth/profile: Update user name, tone, and system prompt
  router.post('/auth/profile', async (req, res) => {
    try {
      const authUser = await resolveUserFromReq(req);
      if (!authUser) {
        return res.status(401).json({ ok: false, error: 'Authentication required to update profile.' });
      }

      const { name, tone, customPrompt } = req.body;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        try {
          await cognitoService.updateUser(token, { name, tone, customPrompt });
        } catch (e) {
          console.warn('[Cognito Update]:', e.message);
        }
      }

      const updatedLocal = await userRepo.updateUserProfile(authUser.id, {
        name,
        tone,
        system_prompt: customPrompt
      });

      res.json({
        ok: true,
        message: 'Profile updated successfully.',
        user: updatedLocal
      });
    } catch (err) {
      console.error('[Profile Update Error]:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/message: Process incoming user chat message
  router.post('/message', async (req, res) => {
    try {
      const authUser = await resolveUserFromReq(req);
      if (!authUser) {
        return res.status(401).json({
          ok: false,
          error: 'Authentication required. Please sign in to use the assistant.'
        });
      }
      const effectiveUserId = authUser.id;
      const { text = '', attachment = null } = req.body;

      const normalizedMessage = {
        userId: effectiveUserId,
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
    const authUser = await resolveUserFromReq(req);
    if (!authUser) {
      res.writeHead(401, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`data: ${JSON.stringify({ type: 'error', text: 'Authentication required.' })}\n\n`);
      return res.end();
    }
    const userId = authUser.id;

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
    const authUser = await resolveUserFromReq(req);
    if (!authUser) {
      return res.status(401).json({ error: 'Authentication required to export data.' });
    }
    const userId = authUser.id;
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
      const authUser = await resolveUserFromReq(req);
      if (!authUser) {
        return res.status(401).json({
          ok: false,
          error: 'Authentication required to view database records.'
        });
      }
      const userId = authUser.id;
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
