const { run, get, all } = require('./db');

function getLocalDateString(date = new Date(), timezone = 'Asia/Kolkata') {
  try {
    // Format to YYYY-MM-DD in the specified timezone
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(date);
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

async function saveExpense(userId, { amount, currency = 'INR', item, category = 'general', rawText = '', date = null, timezone = 'Asia/Kolkata' }) {
  const expenseDate = date || getLocalDateString(new Date(), timezone);
  const now = Date.now();

  const cleanCategory = (category || 'general').trim().toLowerCase();

  // Save to categories table if new
  await run(
    `INSERT OR IGNORE INTO categories (user_id, name, created_at) VALUES (?, ?, ?)`,
    [userId, cleanCategory, now]
  );

  const result = await run(
    `INSERT INTO expenses (user_id, amount, currency, item, category, date, raw_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, Number(amount), currency, item.trim(), cleanCategory, expenseDate, rawText, now, now]
  );

  return {
    id: result.lastID,
    userId,
    amount: Number(amount),
    currency,
    item: item.trim(),
    category: cleanCategory,
    date: expenseDate
  };
}

async function getUserCategories(userId) {
  const rows = await all(
    `SELECT DISTINCT name FROM categories WHERE user_id = ? ORDER BY name ASC`,
    [userId]
  );
  return rows.map(r => r.name);
}

async function getLastExpense(userId) {
  return await get(
    `SELECT * FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [userId]
  );
}

async function updateExpenseCategory(expenseId, newCategory, userId) {
  const cleanCategory = newCategory.trim().toLowerCase();
  const now = Date.now();
  await run(
    `INSERT OR IGNORE INTO categories (user_id, name, created_at) VALUES (?, ?, ?)`,
    [userId, cleanCategory, now]
  );
  await run(
    `UPDATE expenses SET category = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [cleanCategory, now, expenseId, userId]
  );
  return await get(`SELECT * FROM expenses WHERE id = ?`, [expenseId]);
}

async function updateExpenseAmount(expenseId, newAmount, userId) {
  const now = Date.now();
  await run(
    `UPDATE expenses SET amount = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [Number(newAmount), now, expenseId, userId]
  );
  return await get(`SELECT * FROM expenses WHERE id = ?`, [expenseId]);
}

async function deleteExpense(expenseId, userId) {
  return await run(`DELETE FROM expenses WHERE id = ? AND user_id = ?`, [expenseId, userId]);
}

async function getExpenseSummary(userId, { period = 'all', category = null, timezone = 'Asia/Kolkata' } = {}) {
  const today = getLocalDateString(new Date(), timezone);
  
  // Calculate yesterday
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = getLocalDateString(yesterdayDate, timezone);

  // Calculate current month YYYY-MM
  const currentMonth = today.slice(0, 7);

  let whereClauses = ['user_id = ?'];
  let params = [userId];

  if (category) {
    whereClauses.push('LOWER(category) = LOWER(?)');
    params.push(category.trim());
  }

  let periodLabel = 'total';
  if (period === 'today') {
    whereClauses.push('date = ?');
    params.push(today);
    periodLabel = 'today';
  } else if (period === 'yesterday') {
    whereClauses.push('date = ?');
    params.push(yesterday);
    periodLabel = 'yesterday';
  } else if (period === 'this_month') {
    whereClauses.push("substr(date, 1, 7) = ?");
    params.push(currentMonth);
    periodLabel = 'this month';
  }

  const whereSql = whereClauses.join(' AND ');

  const sumRow = await get(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count, currency FROM expenses WHERE ${whereSql}`,
    params
  );

  const breakdownRows = await all(
    `SELECT category, SUM(amount) as category_total, COUNT(*) as count 
     FROM expenses WHERE ${whereSql} 
     GROUP BY category ORDER BY category_total DESC`,
    params
  );

  const recentRows = await all(
    `SELECT item, amount, currency, category, date FROM expenses WHERE ${whereSql} ORDER BY id DESC LIMIT 5`,
    params
  );

  return {
    total: sumRow ? sumRow.total : 0,
    count: sumRow ? sumRow.count : 0,
    currency: (sumRow && sumRow.currency) || 'INR',
    period: periodLabel,
    category: category || null,
    breakdown: breakdownRows,
    recent: recentRows
  };
}

module.exports = {
  getLocalDateString,
  saveExpense,
  getUserCategories,
  getLastExpense,
  updateExpenseCategory,
  updateExpenseAmount,
  deleteExpense,
  getExpenseSummary
};
