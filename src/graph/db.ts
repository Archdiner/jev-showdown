import Database from 'better-sqlite3';
import path from 'path';
import { NodeData, EdgeData, GraphData, Node, Edge } from './schema.js';

export class GraphDB {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.join(process.cwd(), 'state', 'graph.db');
    this.db = new Database(finalPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        owner TEXT,
        session TEXT,
        commit_sha TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metrics TEXT,
        metadata TEXT,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (from_node) REFERENCES nodes(id),
        FOREIGN KEY (to_node) REFERENCES nodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
      CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes(owner);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
    `);
  }

  addNode(node: NodeData): void {
    const parsed = Node.parse(node);
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes 
      (id, type, status, title, description, owner, session, commit_sha, created_at, updated_at, metrics, metadata, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      parsed.id,
      parsed.type,
      parsed.status,
      parsed.title,
      parsed.description || null,
      parsed.owner || null,
      parsed.session || null,
      (parsed as any).commit || null,
      parsed.created_at,
      parsed.updated_at,
      parsed.metrics ? JSON.stringify(parsed.metrics) : null,
      parsed.metadata ? JSON.stringify(parsed.metadata) : null,
      JSON.stringify(parsed)
    );
  }

  getNode(id: string): NodeData | null {
    const row = this.db.prepare('SELECT data FROM nodes WHERE id = ?').get(id) as { data: string } | undefined;
    if (!row) return null;
    return Node.parse(JSON.parse(row.data));
  }

  getNodesByType(type: string, status?: string): NodeData[] {
    let query = 'SELECT data FROM nodes WHERE type = ?';
    const params: any[] = [type];
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    const rows = this.db.prepare(query).all(...params) as { data: string }[];
    return rows.map(row => Node.parse(JSON.parse(row.data)));
  }

  updateNode(id: string, updates: Partial<NodeData>): void {
    const existing = this.getNode(id);
    if (!existing) {
      throw new Error(`Node ${id} not found`);
    }

    const updated = {
      ...existing,
      ...updates,
      updated_at: Date.now(),
    } as NodeData;

    this.addNode(updated);
  }

  addEdge(edge: EdgeData): void {
    const parsed = Edge.parse(edge);
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO edges (id, from_node, to_node, type, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      parsed.id,
      parsed.from_node,
      parsed.to_node,
      parsed.type,
      parsed.created_at,
      parsed.metadata ? JSON.stringify(parsed.metadata) : null
    );
  }

  getEdgesFrom(nodeId: string, edgeType?: string): EdgeData[] {
    let query = 'SELECT * FROM edges WHERE from_node = ?';
    const params: any[] = [nodeId];
    
    if (edgeType) {
      query += ' AND type = ?';
      params.push(edgeType);
    }

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      from_node: row.from_node,
      to_node: row.to_node,
      type: row.type,
      created_at: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  getEdgesTo(nodeId: string, edgeType?: string): EdgeData[] {
    let query = 'SELECT * FROM edges WHERE to_node = ?';
    const params: any[] = [nodeId];
    
    if (edgeType) {
      query += ' AND type = ?';
      params.push(edgeType);
    }

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      from_node: row.from_node,
      to_node: row.to_node,
      type: row.type,
      created_at: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  getFrontier(): NodeData[] {
    // Get unblocked, open/in_progress tasks/experiments with highest value
    // A task is unblocked if it has no open depends_on edges
    const query = `
      SELECT n.data FROM nodes n
      WHERE n.type IN ('Task', 'Experiment', 'Hypothesis')
      AND n.status IN ('open', 'in_progress')
      AND n.id NOT IN (
        SELECT e.from_node FROM edges e
        JOIN nodes n2 ON e.to_node = n2.id
        WHERE e.type = 'depends_on' AND n2.status != 'done'
      )
      ORDER BY n.updated_at DESC
      LIMIT 10
    `;

    const rows = this.db.prepare(query).all() as { data: string }[];
    return rows.map(row => Node.parse(JSON.parse(row.data)));
  }

  exportGraph(): GraphData {
    const nodes = this.db.prepare('SELECT data FROM nodes').all() as { data: string }[];
    const edges = this.db.prepare('SELECT * FROM edges').all() as any[];

    return {
      version: '1.0',
      exported_at: Date.now(),
      nodes: nodes.map(row => Node.parse(JSON.parse(row.data))),
      edges: edges.map(row => ({
        id: row.id,
        from_node: row.from_node,
        to_node: row.to_node,
        type: row.type,
        created_at: row.created_at,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      })),
    };
  }

  close(): void {
    this.db.close();
  }
}
