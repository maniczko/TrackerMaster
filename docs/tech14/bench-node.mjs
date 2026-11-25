// TECH-14: measurement in Node 24 (JavaScript variants + SQLite variants via node:sqlite).
// Usage: node docs/tech14/bench-node.mjs [outDir]   (outDir defaults to the OS temp directory)
// Writes <outDir>/tech14-node-<count>.json and prints Markdown tables. Synthetic data only.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { buildIndex, formatJsResult, measure, QUERIES, queryTerms, runJsBench, searchIndexed, synthesize } from './searchBench.mjs';

const outDir = process.argv[2] ?? tmpdir();
const COUNTS = [10_000, 50_000];
const OPTIONS = { warmup: 3, runs: 15 };

// Application tables used by History (same columns and constraints as src-tauri/src/main.rs, schema v14).
const SCHEMA = `
CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE projects (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL);
CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL);
CREATE UNIQUE INDEX tasks_id_project_identity ON tasks(id,project_id);
CREATE TABLE time_entries (id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), project_id INTEGER NOT NULL REFERENCES projects(id),
  started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER CHECK(duration_seconds >= 0),
  manually_resolved INTEGER NOT NULL DEFAULT 0 CHECK(manually_resolved IN (0,1)),
  CHECK ((ended_at IS NULL AND duration_seconds IS NULL) OR (ended_at IS NOT NULL AND duration_seconds IS NOT NULL)),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
CREATE UNIQUE INDEX one_running_timer ON time_entries((1)) WHERE ended_at IS NULL;
CREATE TABLE entry_deletions (entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id), deleted_at TEXT NOT NULL);
CREATE TABLE billable_entries (entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id));
CREATE TABLE entry_descriptions (entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id), description TEXT NOT NULL CHECK(length(description)<=2000));
`;

function createDatabase(file, catalog, data) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  db.exec('BEGIN');
  const client = db.prepare('INSERT INTO clients(id,name) VALUES(?,?)');
  for (const item of catalog.clients) client.run(item.id, item.name);
  const project = db.prepare('INSERT INTO projects(id,client_id,name) VALUES(?,?,?)');
  for (const item of catalog.projects) project.run(item.id, item.client_id, item.name);
  const task = db.prepare('INSERT INTO tasks(id,project_id,name) VALUES(?,?,?)');
  for (const item of catalog.tasks) task.run(item.id, item.project_id, item.name);
  const entry = db.prepare('INSERT INTO time_entries(id,task_id,project_id,started_at,ended_at,duration_seconds) VALUES(?,?,?,?,?,?)');
  const billable = db.prepare('INSERT INTO billable_entries(entry_id) VALUES(?)');
  const description = db.prepare('INSERT INTO entry_descriptions(entry_id,description) VALUES(?,?)');
  for (const item of data.entries) {
    entry.run(item.id, item.task_id, item.project_id, item.started_at, item.ended_at, item.duration_seconds);
    if (item.billable) billable.run(item.id);
    if (item.description) description.run(item.id, item.description);
  }
  db.exec('COMMIT');
  return db;
}

function fileSize(db, file) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  return statSync(file).size;
}

const LIVE = 'NOT EXISTS(SELECT 1 FROM entry_deletions x WHERE x.entry_id=e.id) AND e.ended_at IS NOT NULL';
const JOIN = 'FROM time_entries e JOIN projects p ON p.id=e.project_id JOIN clients c ON c.id=p.client_id LEFT JOIN tasks t ON t.id=e.task_id LEFT JOIN entry_descriptions d ON d.entry_id=e.id';

// The SQL text for every variant; terms are bound as parameters, never concatenated.
const VARIANTS = {
  // S1: LIKE on the raw columns. SQLite LIKE folds ASCII case only, and no diacritics.
  'S1 LIKE (surowe kolumny)': {
    setup: null,
    sql: terms => `SELECT e.id ${JOIN} WHERE ${LIVE} AND ${terms.map(() => "(COALESCE(d.description,'') || char(10) || c.name || char(10) || p.name || char(10) || COALESCE(t.name,'')) LIKE ?").join(' AND ')} ORDER BY e.id`,
    args: terms => terms.map(term => `%${term}%`),
    terms: query => query.split(/\s+/).filter(Boolean),
  },
  // S2: a folded copy of the searchable text per entry, maintained by the application on every write.
  'S2 LIKE (kolumna znormalizowana)': {
    setup: (db, data, catalog) => {
      db.exec('CREATE TABLE entry_search (entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id), text TEXT NOT NULL)');
      const index = buildIndex(data, catalog);
      const insert = db.prepare('INSERT INTO entry_search(entry_id,text) VALUES(?,?)');
      db.exec('BEGIN');
      index.entries.forEach((entry, i) => insert.run(entry.id, index.texts[i]));
      db.exec('COMMIT');
    },
    sql: terms => `SELECT e.id FROM time_entries e JOIN entry_search s ON s.entry_id=e.id WHERE ${LIVE} AND ${terms.map(() => 's.text LIKE ?').join(' AND ')} ORDER BY e.id`,
    args: terms => terms.map(term => `%${term}%`),
    terms: queryTerms,
  },
  // S3: FTS5 with the unicode61 tokenizer and remove_diacritics 2 on the original text (prefix queries).
  'S3 FTS5 unicode61 remove_diacritics 2': {
    setup: (db) => {
      db.exec(`CREATE VIRTUAL TABLE entry_fts USING fts5(text, tokenize="unicode61 remove_diacritics 2")`);
      db.exec(`INSERT INTO entry_fts(rowid,text) SELECT e.id, COALESCE(d.description,'') || char(10) || c.name || char(10) || p.name || char(10) || COALESCE(t.name,'') ${JOIN}`);
    },
    sql: () => `SELECT e.id FROM entry_fts f JOIN time_entries e ON e.id=f.rowid WHERE entry_fts MATCH ? AND ${LIVE} ORDER BY e.id`,
    args: terms => [terms.map(term => `"${term.replace(/"/g, '""')}"*`).join(' ')],
    terms: query => query.split(/\s+/).filter(Boolean),
  },
  // S4: as S3, but the text and the query are folded by the application first (fixes "ł").
  'S4 FTS5 na tekście znormalizowanym': {
    setup: (db, data, catalog) => {
      db.exec(`CREATE VIRTUAL TABLE entry_fts_folded USING fts5(text, tokenize="unicode61 remove_diacritics 2")`);
      const index = buildIndex(data, catalog);
      const insert = db.prepare('INSERT INTO entry_fts_folded(rowid,text) VALUES(?,?)');
      db.exec('BEGIN');
      index.entries.forEach((entry, i) => insert.run(entry.id, index.texts[i]));
      db.exec('COMMIT');
    },
    sql: () => `SELECT e.id FROM entry_fts_folded f JOIN time_entries e ON e.id=f.rowid WHERE entry_fts_folded MATCH ? AND ${LIVE} ORDER BY e.id`,
    args: terms => [terms.map(term => `"${term.replace(/"/g, '""')}"*`).join(' ')],
    terms: queryTerms,
  },
  // S5: FTS5 trigram (substring like JS includes), on folded text; terms shorter than 3 characters cannot use it.
  'S5 FTS5 trigram (tekst znormalizowany)': {
    setup: (db, data, catalog) => {
      db.exec(`CREATE VIRTUAL TABLE entry_tri USING fts5(text, tokenize="trigram")`);
      const index = buildIndex(data, catalog);
      const insert = db.prepare('INSERT INTO entry_tri(rowid,text) VALUES(?,?)');
      db.exec('BEGIN');
      index.entries.forEach((entry, i) => insert.run(entry.id, index.texts[i]));
      db.exec('COMMIT');
    },
    sql: () => `SELECT e.id FROM entry_tri f JOIN time_entries e ON e.id=f.rowid WHERE entry_tri MATCH ? AND ${LIVE} ORDER BY e.id`,
    args: terms => [terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' ')],
    terms: queryTerms,
    minLength: 3,
  },
};

function runSqliteBench(count) {
  const { catalog, data } = synthesize(count);
  const reference = buildIndex(data, catalog);
  const dir = mkdtempSync(join(outDir, 'tech14-'));
  const file = join(dir, 'history.sqlite3');
  try {
    const db = createDatabase(file, catalog, data);
    const baseBytes = fileSize(db, file);
    const results = [];
    for (const [name, variant] of Object.entries(VARIANTS)) {
      let setupMs = 0;
      let bytes = baseBytes;
      if (variant.setup) {
        const t0 = performance.now();
        variant.setup(db, data, catalog);
        setupMs = performance.now() - t0;
        bytes = fileSize(db, file);
      }
      const rows = [];
      for (const item of QUERIES) {
        const terms = variant.terms(item.query);
        const expected = searchIndexed(reference, item.query).map(entry => entry.id);
        if (variant.minLength && terms.some(term => [...term].length < variant.minLength)) {
          rows.push({ id: item.id, matches: null, expected: expected.length, ms: null, correct: 'nie obsługuje (< 3 znaki)' });
          continue;
        }
        const statement = db.prepare(variant.sql(terms));
        const args = variant.args(terms);
        const timing = measure(() => statement.all(...args).map(row => row.id), OPTIONS);
        const ids = timing.value;
        const correct = ids.length === expected.length && ids.every((id, i) => id === expected[i]);
        rows.push({ id: item.id, matches: ids.length, expected: expected.length, ms: { median: r2(timing.median), p95: r2(timing.p95), max: r2(timing.max), runs: timing.runs }, correct: correct ? 'tak' : 'NIE' });
      }
      results.push({ name, setupMs: r2(setupMs), bytes, deltaBytes: bytes - baseBytes, rows });
      // Each variant is measured against the base database plus only its own index.
      db.exec('DROP TABLE IF EXISTS entry_search; DROP TABLE IF EXISTS entry_fts; DROP TABLE IF EXISTS entry_fts_folded; DROP TABLE IF EXISTS entry_tri;');
    }
    const version = db.prepare('SELECT sqlite_version() AS v').get().v;
    db.close();
    return { count, sqlite: version, baseBytes, results };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const r2 = value => Math.round(value * 100) / 100;
const fmt = timing => timing ? `${timing.median} / ${timing.p95}` : '—';
const kb = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const environment = {
  node: process.version, platform: `${process.platform} ${process.arch}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
  memoryGB: Math.round(totalmem() / 1024 ** 3), measuredAt: new Date().toISOString(), runs: OPTIONS,
};
console.log('Environment', JSON.stringify(environment));
for (const count of COUNTS) {
  const js = runJsBench(count, OPTIONS);
  const sqlite = runSqliteBench(count);
  writeFileSync(join(outDir, `tech14-node-${count}.json`), JSON.stringify({ environment, js, sqlite }, null, 2));
  console.log(`\n## ${count} wpisów (Node ${process.version}, SQLite ${sqlite.sqlite})`);
  console.log(formatJsResult(js));
  console.log(`\nBaza bez indeksu wyszukiwania: ${kb(sqlite.baseBytes)}`);
  console.log(`\n| Wariant SQLite | Budowa (ms) | Przyrost bazy | ${QUERIES.map(item => `\`${item.query}\``).join(' | ')} |`);
  console.log(`|---|---:|---:|${QUERIES.map(() => '---').join('|')}|`);
  for (const variant of sqlite.results) {
    console.log(`| ${variant.name} | ${variant.setupMs} | ${variant.deltaBytes ? `+${kb(variant.deltaBytes)}` : '0'} | ${variant.rows.map(row => row.ms ? `${fmt(row.ms)} ms; ${row.matches}/${row.expected} ${row.correct === 'tak' ? '✓' : '✗'}` : row.correct).join(' | ')} |`);
  }
}
console.log('\nCzasy: mediana / p95 w ms. ✓ = te same wpisy co wariant JS (wzorzec), ✗ = inne wyniki.');

