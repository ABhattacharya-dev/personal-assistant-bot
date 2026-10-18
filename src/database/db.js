const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Ensure database directory exists
const dbDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(config.DB_PATH);

// Promise-based helpers
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Initialize tables
async function initSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      timezone TEXT DEFAULT 'Asia/Kolkata',
      created_at INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      item TEXT NOT NULL,
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      raw_text TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER,
      UNIQUE(user_id, name)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      due_timestamp INTEGER NOT NULL,
      interval_seconds INTEGER DEFAULT 0,
      is_recurring INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      channel TEXT DEFAULT 'web',
      created_at INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS memory_vault (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      entity TEXT,
      amount REAL,
      title TEXT,
      content TEXT NOT NULL,
      date TEXT,
      created_at INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      text TEXT NOT NULL,
      delivered INTEGER DEFAULT 0,
      delivered_at INTEGER,
      created_at INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      action_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at INTEGER,
      expires_at INTEGER
    )
  `);
}

module.exports = {
  db,
  run,
  get,
  all,
  initSchema
};
