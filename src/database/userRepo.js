const { run, get, all } = require('./db');

async function ensureUser(userId, timezone = 'Asia/Kolkata') {
  const existing = await get(`SELECT * FROM users WHERE id = ?`, [userId]);
  if (!existing) {
    await run(
      `INSERT INTO users (id, timezone, created_at) VALUES (?, ?, ?)`,
      [userId, timezone, Date.now()]
    );
    return { id: userId, timezone };
  }
  return existing;
}

async function getUser(userId) {
  return await get(`SELECT * FROM users WHERE id = ?`, [userId]);
}

// Pending Actions (Confirmations & Disambiguation)
async function setPendingAction(userId, actionType, payload, prompt, ttlSeconds = 300) {
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const payloadStr = JSON.stringify(payload);

  await run(
    `INSERT INTO pending_actions (user_id, action_type, payload, prompt, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       action_type = excluded.action_type,
       payload = excluded.payload,
       prompt = excluded.prompt,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    [userId, actionType, payloadStr, prompt, now, expiresAt]
  );
}

async function getPendingAction(userId) {
  const row = await get(`SELECT * FROM pending_actions WHERE user_id = ?`, [userId]);
  if (!row) return null;

  if (Date.now() > row.expires_at) {
    await clearPendingAction(userId);
    return null;
  }

  try {
    return {
      actionType: row.action_type,
      payload: JSON.parse(row.payload),
      prompt: row.prompt
    };
  } catch (e) {
    return null;
  }
}

async function clearPendingAction(userId) {
  await run(`DELETE FROM pending_actions WHERE user_id = ?`, [userId]);
}

// Export and Delete All (Privacy compliance)
async function exportAllUserData(userId) {
  const user = await get(`SELECT * FROM users WHERE id = ?`, [userId]);
  const expenses = await all(`SELECT * FROM expenses WHERE user_id = ? ORDER BY id ASC`, [userId]);
  const categories = await all(`SELECT * FROM categories WHERE user_id = ? ORDER BY id ASC`, [userId]);
  const reminders = await all(`SELECT * FROM reminders WHERE user_id = ? ORDER BY id ASC`, [userId]);
  const memoryVault = await all(`SELECT * FROM memory_vault WHERE user_id = ? ORDER BY id ASC`, [userId]);

  return {
    exportDate: new Date().toISOString(),
    user,
    expenses,
    categories: categories.map(c => c.name),
    reminders,
    memoryVault
  };
}

async function deleteAllUserData(userId) {
  await run(`DELETE FROM expenses WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM categories WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM reminders WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM memory_vault WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM notifications WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM pending_actions WHERE user_id = ?`, [userId]);
  return { deleted: true };
}

module.exports = {
  ensureUser,
  getUser,
  setPendingAction,
  getPendingAction,
  clearPendingAction,
  exportAllUserData,
  deleteAllUserData
};
