const { run, get, all } = require('./db');
const { getLocalDateString } = require('./expenseRepo');

async function saveMemory(userId, { entity = null, amount = null, title = null, content, date = null, timezone = 'Asia/Kolkata' }) {
  const memDate = date || getLocalDateString(new Date(), timezone);
  const now = Date.now();

  const cleanEntity = entity ? entity.trim() : null;
  const numAmount = amount !== null && amount !== undefined ? Number(amount) : null;
  const cleanTitle = title ? title.trim() : null;

  const result = await run(
    `INSERT INTO memory_vault (user_id, entity, amount, title, content, date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, cleanEntity, numAmount, cleanTitle, content.trim(), memDate, now]
  );

  return {
    id: result.lastID,
    userId,
    entity: cleanEntity,
    amount: numAmount,
    title: cleanTitle,
    content: content.trim(),
    date: memDate
  };
}

async function queryMemory(userId, { query = '', entity = null, amount = null } = {}) {
  let whereClauses = ['user_id = ?'];
  let params = [userId];

  if (entity) {
    whereClauses.push('(LOWER(entity) LIKE ? OR LOWER(content) LIKE ?)');
    params.push(`%${entity.trim().toLowerCase()}%`, `%${entity.trim().toLowerCase()}%`);
  }

  if (amount !== null && amount !== undefined && !isNaN(amount)) {
    whereClauses.push('amount = ?');
    params.push(Number(amount));
  }

  if (query) {
    // Break search terms if multiple words, ignore stopwords
    const stopWords = new Set(['what', 'did', 'i', 'pay', 'to', 'for', 'the', 'my', 'is', 'a', 'an', 'and', 'was', 'at', 'in', 'on', 'tell', 'me', 'show']);
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map(t => t.replace(/[^a-zA-Z0-9]/g, ''))
      .filter(t => t.length > 1 && !stopWords.has(t));

    if (terms.length > 0) {
      const termConditions = terms.map(() => '(LOWER(content) LIKE ? OR LOWER(entity) LIKE ?)');
      whereClauses.push(`(${termConditions.join(' OR ')})`);
      for (const t of terms) {
        params.push(`%${t}%`, `%${t}%`);
      }
    } else {
      whereClauses.push('LOWER(content) LIKE ?');
      params.push(`%${query.trim().toLowerCase()}%`);
    }
  }

  const sql = `SELECT * FROM memory_vault WHERE ${whereClauses.join(' AND ')} ORDER BY id DESC LIMIT 20`;
  const rows = await all(sql, params);
  return rows;
}

async function getMemoryById(id, userId) {
  return await get(`SELECT * FROM memory_vault WHERE id = ? AND user_id = ?`, [id, userId]);
}

module.exports = {
  saveMemory,
  queryMemory,
  getMemoryById
};
