import Database from 'better-sqlite3';
import { BattleRecord, DecisionRecord } from '../types/index.js';
import * as path from 'path';

export class BattleLogger {
  private db: Database.Database;

  constructor(dbPath: string = 'battles.db') {
    this.db = new Database(dbPath);
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS battles (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        turns INTEGER NOT NULL,
        opponent TEXT NOT NULL,
        rating INTEGER,
        log TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        battle_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        state TEXT NOT NULL,
        action TEXT NOT NULL,
        search_stats TEXT NOT NULL,
        evaluation TEXT NOT NULL,
        FOREIGN KEY (battle_id) REFERENCES battles(id)
      );

      CREATE INDEX IF NOT EXISTS idx_battles_outcome ON battles(outcome);
      CREATE INDEX IF NOT EXISTS idx_battles_timestamp ON battles(timestamp);
      CREATE INDEX IF NOT EXISTS idx_decisions_battle_id ON decisions(battle_id);
    `);
  }

  logBattle(record: BattleRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO battles (id, timestamp, outcome, turns, opponent, rating, log)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.timestamp,
      record.outcome,
      record.turns,
      record.opponent,
      record.rating || null,
      record.log
    );

    const decisionStmt = this.db.prepare(`
      INSERT INTO decisions (battle_id, turn, state, action, search_stats, evaluation)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const decision of record.decisions) {
      decisionStmt.run(
        record.id,
        decision.turn,
        decision.state,
        JSON.stringify(decision.action),
        JSON.stringify(decision.searchStats),
        JSON.stringify(decision.evaluation)
      );
    }
  }

  getBattle(id: string): BattleRecord | null {
    const battle = this.db
      .prepare('SELECT * FROM battles WHERE id = ?')
      .get(id) as any;

    if (!battle) return null;

    const decisions = this.db
      .prepare('SELECT * FROM decisions WHERE battle_id = ? ORDER BY turn')
      .all(id) as any[];

    return {
      id: battle.id,
      timestamp: battle.timestamp,
      outcome: battle.outcome,
      turns: battle.turns,
      opponent: battle.opponent,
      rating: battle.rating,
      log: battle.log,
      decisions: decisions.map(d => ({
        turn: d.turn,
        state: d.state,
        action: JSON.parse(d.action),
        searchStats: JSON.parse(d.search_stats),
        evaluation: JSON.parse(d.evaluation),
      })),
    };
  }

  getRecentBattles(limit: number = 100): BattleRecord[] {
    const battles = this.db
      .prepare('SELECT * FROM battles ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as any[];

    return battles.map(b => ({
      id: b.id,
      timestamp: b.timestamp,
      outcome: b.outcome,
      turns: b.turns,
      opponent: b.opponent,
      rating: b.rating,
      log: b.log,
      decisions: [],
    }));
  }

  getLosses(limit: number = 50): BattleRecord[] {
    const battles = this.db
      .prepare(`SELECT * FROM battles WHERE outcome = 'loss' ORDER BY timestamp DESC LIMIT ?`)
      .all(limit) as any[];

    return battles.map(b => this.getBattle(b.id)!).filter(b => b !== null);
  }

  getWinRate(since?: number): { wins: number; losses: number; ties: number; winRate: number } {
    const query = since
      ? 'SELECT outcome, COUNT(*) as count FROM battles WHERE timestamp >= ? GROUP BY outcome'
      : 'SELECT outcome, COUNT(*) as count FROM battles GROUP BY outcome';

    const results = since
      ? this.db.prepare(query).all(since)
      : this.db.prepare(query).all();

    let wins = 0;
    let losses = 0;
    let ties = 0;

    for (const row of results as any[]) {
      if (row.outcome === 'win') wins = row.count;
      else if (row.outcome === 'loss') losses = row.count;
      else if (row.outcome === 'tie') ties = row.count;
    }

    const total = wins + losses + ties;
    const winRate = total > 0 ? wins / total : 0;

    return { wins, losses, ties, winRate };
  }

  close(): void {
    this.db.close();
  }
}
