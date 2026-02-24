/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const initSqlJs = require('sql.js');

const SQLITE_DB_PATH =
  process.env.SQLITE_DB_PATH ||
  path.resolve(process.cwd(), '..', 'data', 'football_predictor.db');
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.');
  process.exit(1);
}

if (!fs.existsSync(SQLITE_DB_PATH)) {
  console.error(`SQLite database not found: ${SQLITE_DB_PATH}`);
  process.exit(1);
}

let sqlite = null;
let turso = null;

const importOrder = [
  'matches',
  'teams',
  'players',
  'referees',
  'model_params',
  'users',
  'budgets',
  'bets',
  'backtest_results',
];

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function recreateSchema() {
  const rows = execRows(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

  if (!rows.length) throw new Error('No tables found in SQLite DB.');

  const byName = new Map(rows.map((r) => [r.name, r.sql]));
  const orderedTables = [
    ...importOrder.filter((t) => byName.has(t)),
    ...rows.map((r) => r.name).filter((t) => !importOrder.includes(t)),
  ];

  await turso.execute('PRAGMA foreign_keys = OFF;');
  for (const table of orderedTables) {
    await turso.execute(`DROP TABLE IF EXISTS ${quoteIdent(table)};`);
  }
  for (const table of orderedTables) {
    const createSql = byName.get(table);
    if (!createSql) continue;
    await turso.execute(createSql);
  }
  await turso.execute('PRAGMA foreign_keys = ON;');

  return orderedTables;
}

async function copyTable(tableName) {
  const rows = execRows(`SELECT * FROM ${quoteIdent(tableName)}`);
  if (rows.length === 0) {
    console.log(`[${tableName}] 0 rows`);
    return;
  }

  const cols = Object.keys(rows[0]);
  const colList = cols.map(quoteIdent).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const insertSql = `INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES (${placeholders})`;

  const chunkSize = 200;
  let done = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const stmts = chunk.map((row) => ({
      sql: insertSql,
      args: cols.map((c) => row[c]),
    }));
    await turso.batch(stmts, 'write');
    done += chunk.length;
    if (done % 1000 === 0 || done === rows.length) {
      console.log(`[${tableName}] ${done}/${rows.length}`);
    }
  }
}

async function run() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });
  const dbBytes = fs.readFileSync(SQLITE_DB_PATH);
  sqlite = new SQL.Database(dbBytes);
  turso = createClient({
    url: TURSO_DATABASE_URL,
    authToken: TURSO_AUTH_TOKEN,
  });

  try {
    console.log(`SQLite source: ${SQLITE_DB_PATH}`);
    console.log(`Turso target: ${TURSO_DATABASE_URL}`);

    const tables = await recreateSchema();
    console.log(`Schema created. Tables: ${tables.join(', ')}`);

    for (const table of tables) {
      await copyTable(table);
    }

    console.log('Migration completed.');
  } finally {
    if (sqlite) sqlite.close();
    if (turso) turso.close();
  }
}

function execRows(sql) {
  const result = sqlite.exec(sql);
  if (!Array.isArray(result) || result.length === 0) return [];
  const first = result[0];
  const columns = first.columns ?? [];
  const values = first.values ?? [];
  return values.map((arr) => {
    const row = {};
    for (let i = 0; i < columns.length; i++) row[columns[i]] = arr[i];
    return row;
  });
}

run().catch((err) => {
  console.error('Migration failed:', err?.message || err);
  process.exit(1);
});
