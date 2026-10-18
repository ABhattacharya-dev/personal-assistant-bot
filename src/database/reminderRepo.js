const { run, get, all } = require('./db');

async function createReminder(userId, { text, dueTimestamp, intervalSeconds = 0, isRecurring = false, channel = 'web' }) {
  const now = Date.now();
  const res = await run(
    `INSERT INTO reminders (user_id, text, due_timestamp, interval_seconds, is_recurring, status, channel, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [userId, text.trim(), dueTimestamp, intervalSeconds, isRecurring ? 1 : 0, channel, now]
  );
  return {
    id: res.lastID,
    userId,
    text: text.trim(),
    dueTimestamp,
    intervalSeconds,
    isRecurring: Boolean(isRecurring),
    status: 'pending'
  };
}

async function cancelReminders(userId, targetText) {
  const cleanTarget = (targetText || '').trim().toLowerCase();
  let sql, params;
  if (!cleanTarget || cleanTarget === 'all') {
    sql = `UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'`;
    params = [userId];
  } else {
    sql = `UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND status = 'pending' AND LOWER(text) LIKE ?`;
    params = [userId, `%${cleanTarget}%`];
  }
  const result = await run(sql, params);
  return result.changes;
}

async function getActiveReminders(userId) {
  return await all(
    `SELECT * FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY due_timestamp ASC`,
    [userId]
  );
}

async function getDueReminders(currentTime = Date.now()) {
  return await all(
    `SELECT * FROM reminders WHERE status = 'pending' AND due_timestamp <= ?`,
    [currentTime]
  );
}

async function markReminderDelivered(id) {
  return await run(`UPDATE reminders SET status = 'delivered' WHERE id = ?`, [id]);
}

async function rescheduleRecurringReminder(id, nextDueTimestamp) {
  return await run(
    `UPDATE reminders SET due_timestamp = ? WHERE id = ?`,
    [nextDueTimestamp, id]
  );
}

// Notifications
async function saveNotification(userId, channel, text) {
  const now = Date.now();
  return await run(
    `INSERT INTO notifications (user_id, channel, text, delivered, created_at) VALUES (?, ?, ?, 0, ?)`,
    [userId, channel, text, now]
  );
}

async function getUnreadNotifications(userId) {
  const rows = await all(
    `SELECT * FROM notifications WHERE user_id = ? AND delivered = 0 ORDER BY id ASC`,
    [userId]
  );
  return rows;
}

async function markNotificationsDelivered(userId, ids = []) {
  if (ids.length === 0) {
    return await run(`UPDATE notifications SET delivered = 1, delivered_at = ? WHERE user_id = ?`, [Date.now(), userId]);
  }
  const placeholders = ids.map(() => '?').join(',');
  return await run(
    `UPDATE notifications SET delivered = 1, delivered_at = ? WHERE user_id = ? AND id IN (${placeholders})`,
    [Date.now(), userId, ...ids]
  );
}

module.exports = {
  createReminder,
  cancelReminders,
  getActiveReminders,
  getDueReminders,
  markReminderDelivered,
  rescheduleRecurringReminder,
  saveNotification,
  getUnreadNotifications,
  markNotificationsDelivered
};
