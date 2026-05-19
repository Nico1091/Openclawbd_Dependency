'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const initSqlJs = require('sql.js');

const DEFAULT_DB = process.env.MEMORY_DB_PATH || 
  path.join(os.homedir(), '.openclaw', 'plugin-skills', 'Integration_Database', 'memory.db');

class MemoryManager {
  constructor(db, dbPath) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath) {
    const SQL = await initSqlJs();
    let db;
    
    // Crear el directorio si no existe
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
      // Inicializar esquema FTS5 basado en tu database.db
      db.run(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT DEFAULT 'gemma4', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), metadata TEXT DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, type TEXT NOT NULL DEFAULT 'fact', scope TEXT NOT NULL DEFAULT 'user', content TEXT NOT NULL, importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0, last_accessed TEXT, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT, metadata TEXT DEFAULT '{}');
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='id', tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content); END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content); END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content); INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content); END;
      `);
    }
    const manager = new MemoryManager(db, dbPath);
    manager._persist();
    return manager;
  }

  _persist() {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  save(content, opts = {}) {
    const type = opts.type || 'fact';
    const scope = opts.scope || 'user';
    const sessionId = opts.sessionId || null;
    const importance = opts.importance ?? 0.5;

    const stmt = this.db.prepare("INSERT INTO memories (content, type, scope, session_id, importance) VALUES (?, ?, ?, ?, ?)");
    stmt.run([content, type, scope, sessionId, importance]);
    stmt.free();

    const res = this.db.exec("SELECT last_insert_rowid() as id");
    const id = res[0].values[0][0];

    this._persist();
    return id;
  }

  search(query, opts = {}) {
    const limit = opts.limit || 10;
    const sql = `SELECT id, content, type, scope, importance, created_at FROM memories WHERE id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?) ORDER BY importance DESC LIMIT ?`;
    try {
      const stmt = this.db.prepare(sql);
      stmt.bind([query, limit]);
      const results = [];
      while (stmt.step()) { results.push(stmt.getAsObject()); }
      stmt.free();
      return results;
    } catch(e) {
      return []; // FTS5 MATCH fails gracefully on empty or bad syntax
    }
  }

  recall(opts = {}) {
    const limit = opts.limit || 20;
    const sql = `SELECT id, content, type, scope, importance, created_at FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    stmt.bind([limit]);
    const results = [];
    while (stmt.step()) { results.push(stmt.getAsObject()); }
    stmt.free();
    return results;
  }

  forget(id) {
    const stmt = this.db.prepare("DELETE FROM memories WHERE id = ?");
    stmt.run([id]);
    stmt.free();
    this._persist();
  }

  buildContextBlock(query, opts = {}) {
    const memories = query ? this.search(query, {limit: 5}) : this.recall({limit: 5});
    if (memories.length === 0) return "";
    return "Relevant Context:\n" + memories.map(m => `- [${m.type}] ${m.content}`).join("\n");
  }

  close() {
    this.db.close();
  }
}

module.exports = { MemoryManager, DEFAULT_DB };