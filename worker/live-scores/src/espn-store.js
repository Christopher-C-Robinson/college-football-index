// Additive ESPN tables inside the existing LiveScoreCache SQLite storage. The
// BBS tables (live_state, live_catalog, daily_budgets, ...) are never touched.
import { isResolved } from './espn-scoreboard.js';

const PARAM_CHUNK = 50;

const parse = body => {
  try { return body ? JSON.parse(body) : null; } catch { return null; }
};

function chunks(values) {
  const out = [];
  for (let index = 0; index < values.length; index += PARAM_CHUNK) out.push(values.slice(index, index + PARAM_CHUNK));
  return out;
}

export function ensureEspnSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS espn_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT)`);
  sql.exec('INSERT OR IGNORE INTO espn_state (id) VALUES (1)');
  sql.exec(`CREATE TABLE IF NOT EXISTS espn_boards (
    board_key TEXT PRIMARY KEY, board_date TEXT NOT NULL, body TEXT NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS espn_boards_date ON espn_boards (board_date)');
  sql.exec(`CREATE TABLE IF NOT EXISTS espn_games (
    id TEXT PRIMARY KEY, game_date TEXT NOT NULL, start_ms INTEGER NOT NULL,
    unresolved INTEGER NOT NULL, retain_ms INTEGER NOT NULL, body TEXT NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS espn_games_date ON espn_games (game_date)');
  sql.exec('CREATE INDEX IF NOT EXISTS espn_games_unresolved ON espn_games (unresolved, start_ms)');
}

/** `storage` is a Durable Object storage (sql + transactionSync) or a test double. */
export function createEspnStore(storage) {
  const sql = storage.sql;
  ensureEspnSchema(sql);
  const bodies = cursor => cursor.toArray().map(row => parse(row.body)).filter(Boolean);
  const boardMap = rows => new Map(rows.filter(meta => meta.group && meta.boardDate)
    .map(meta => [meta.group + ':' + meta.boardDate, meta]));
  return {
    readSource() {
      return parse(sql.exec('SELECT body FROM espn_state WHERE id = 1').toArray()[0]?.body) || {};
    },
    readBoards(minBoardDate) {
      return boardMap(bodies(sql.exec('SELECT body FROM espn_boards WHERE board_date >= ?', minBoardDate)));
    },
    readBoardsForDates(dates) {
      const rows = [];
      for (const part of chunks([...new Set(dates)])) {
        rows.push(...bodies(sql.exec(`SELECT body FROM espn_boards WHERE board_date IN (${part.map(() => '?').join(',')})`, ...part)));
      }
      return boardMap(rows);
    },
    readBoardsForKeys(keys) {
      const rows = [];
      for (const part of chunks([...new Set(keys)])) {
        rows.push(...bodies(sql.exec(`SELECT body FROM espn_boards WHERE board_key IN (${part.map(() => '?').join(',')})`, ...part)));
      }
      return boardMap(rows);
    },
    readAllBoards() {
      return boardMap(bodies(sql.exec('SELECT body FROM espn_boards ORDER BY board_date')));
    },
    // Every pending row, any age, no LIMIT: pending games are never dropped.
    readUnresolved() {
      return bodies(sql.exec('SELECT body FROM espn_games WHERE unresolved = 1 ORDER BY start_ms'));
    },
    // The full retained archive (bounded by prune) for the default public feed.
    readAllGames() {
      return bodies(sql.exec('SELECT body FROM espn_games ORDER BY start_ms'));
    },
    readGames(ids) {
      const found = new Map();
      for (const part of chunks([...new Set(ids)])) {
        for (const row of bodies(sql.exec(`SELECT body FROM espn_games WHERE id IN (${part.map(() => '?').join(',')})`, ...part))) {
          found.set(row.id, row);
        }
      }
      return found;
    },
    readGamesForDates(dates) {
      const rows = [];
      for (const part of chunks([...new Set(dates)])) {
        rows.push(...bodies(sql.exec(`SELECT body FROM espn_games WHERE game_date IN (${part.map(() => '?').join(',')})
          ORDER BY start_ms`, ...part)));
      }
      return rows;
    },
    commit({ source, boards = new Map(), games = [] }) {
      storage.transactionSync(() => {
        if (source) sql.exec('UPDATE espn_state SET body = ? WHERE id = 1', JSON.stringify(source));
        for (const [key, meta] of boards) {
          sql.exec(`INSERT INTO espn_boards (board_key, board_date, body) VALUES (?, ?, ?)
            ON CONFLICT(board_key) DO UPDATE SET board_date = excluded.board_date, body = excluded.body`,
          key, meta.boardDate, JSON.stringify(meta));
        }
        for (const row of games) {
          const start = Date.parse(row.startDate);
          // Retention runs from the later of kickoff and final retrieval, so a
          // late-recovered final keeps its full window.
          const retain = Math.max(start, Date.parse(row.finalFetchedAt || '') || 0);
          sql.exec(`INSERT INTO espn_games (id, game_date, start_ms, unresolved, retain_ms, body) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET game_date = excluded.game_date, start_ms = excluded.start_ms,
            unresolved = excluded.unresolved, retain_ms = excluded.retain_ms, body = excluded.body`,
          row.id, row.date, start, isResolved(row) ? 0 : 1, retain, JSON.stringify(row));
        }
      });
    },
    /**
     * Retention (from kickoff or later final retrieval) for resolved rows only; pending rows and the boards
     * they reference are never deleted. Over the cap, only resolved rows older
     * than evictableBeforeMs are evicted; otherwise the excess is reported.
     */
    prune({ resolvedBeforeMs, evictableBeforeMs, minBoardDate, maxGames }) {
      return storage.transactionSync(() => {
        const count = query => Number(sql.exec(query).toArray()[0]?.n || 0);
        const before = count('SELECT COUNT(*) AS n FROM espn_games');
        sql.exec('DELETE FROM espn_games WHERE unresolved = 0 AND retain_ms < ?', resolvedBeforeMs);
        let total = count('SELECT COUNT(*) AS n FROM espn_games');
        const deletedResolved = before - total;
        let evicted = 0;
        if (total > maxGames) {
          sql.exec(`DELETE FROM espn_games WHERE id IN (SELECT id FROM espn_games
            WHERE unresolved = 0 AND retain_ms < ? ORDER BY retain_ms ASC LIMIT ?)`, evictableBeforeMs, total - maxGames);
          evicted = total - count('SELECT COUNT(*) AS n FROM espn_games');
          total -= evicted;
        }
        const pendingKeys = new Set(bodies(sql.exec('SELECT body FROM espn_games WHERE unresolved = 1'))
          .flatMap(row => row.boardKeys || []));
        const oldBoards = sql.exec('SELECT board_key FROM espn_boards WHERE board_date < ?', minBoardDate).toArray()
          .map(row => row.board_key).filter(item => !pendingKeys.has(item));
        for (const part of chunks(oldBoards)) {
          sql.exec(`DELETE FROM espn_boards WHERE board_key IN (${part.map(() => '?').join(',')})`, ...part);
        }
        const pending = count('SELECT COUNT(*) AS n FROM espn_games WHERE unresolved = 1');
        return { storedGames: total, pendingGames: pending, deletedResolved, evicted, deletedBoards: oldBoards.length,
          storedBoards: count('SELECT COUNT(*) AS n FROM espn_boards'), maxGames,
          // Reached only if pending/recent finals alone exceed the cap: report, don't delete.
          overCap: total > maxGames };
      });
    }
  };
}
