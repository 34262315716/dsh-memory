/**
 * dsh-memory 存储层：嵌入式 SQLite（node:sqlite，零编译）。
 *
 * 单库结构（WAL + STRICT + user_version 迁移）：
 *   - memories          记忆身份 + 活跃切片（id 跨版本不变）
 *   - memory_versions   版本历史（世界线：valid_from/valid_to/superseded_by/revision）
 *   - memories_fts      FTS5（trigram tokenizer，原生支持中文子串）
 *   - nodes / edges     图谱骨架（阶段一：mentions 共现边）
 *
 * 时间维度（worldline）：time 开关开启时，更新 = 追加版本 + 更新活跃切片，
 * 旧版本保留但隐藏（valid_to 非空，不参与检索/注入）。
 */

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  layer         TEXT NOT NULL CHECK (layer IN ('ep', 'sm')),
  type          TEXT NOT NULL DEFAULT 'note',
  scope         TEXT NOT NULL DEFAULT 'global',
  content       TEXT NOT NULL,
  keywords      TEXT NOT NULL DEFAULT '[]',
  strength      REAL NOT NULL DEFAULT 1.0,
  last_access   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  content       TEXT NOT NULL,
  keywords      TEXT NOT NULL DEFAULT '[]',
  valid_from    INTEGER NOT NULL,
  valid_to      INTEGER,
  superseded_by INTEGER
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_active ON memory_versions(memory_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tokenize = 'trigram');

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('entity', 'event', 'state')),
  label      TEXT NOT NULL,
  memory_id  TEXT REFERENCES memories(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('mentions', 'partOf', 'similarTo', 'causes', 'solves', 'before', 'supports', 'contradicts')),
  from_node  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_node    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  valid_from INTEGER NOT NULL,
  valid_to   INTEGER,
  weight     REAL NOT NULL DEFAULT 1.0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);
`

/** 关键词提取：英文词（>=3）+ 数字 + 中文 2-gram（与旧插件一致，阶段二升级向量）。 */
export function tokenize(text) {
  const tokens = new Set()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) tokens.add(m[0])
  for (const seg of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const s = seg[0]
    for (let i = 0; i < s.length - 1; i++) tokens.add(s.slice(i, i + 2))
  }
  return tokens
}

/** Jaccard 相似度（用于去重合并）。 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

export class MemoryStore {
  /**
   * @param {string} dbFile SQLite 文件路径
   * @param {object} opts { time: boolean, maxVersions: number }
   */
  constructor(dbFile, opts = {}) {
    this.time = opts.time ?? true
    this.maxVersions = opts.maxVersions ?? 8
    this.db = new DatabaseSync(dbFile)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.#prepare()
  }

  #prepare() {
    this.stmt = {
      insertMemory: this.db.prepare(
        'INSERT INTO memories (id, layer, type, scope, content, keywords, strength, last_access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      updateMemory: this.db.prepare(
        'UPDATE memories SET content = ?, keywords = ?, strength = ?, updated_at = ? WHERE id = ?',
      ),
      touchMemory: this.db.prepare('UPDATE memories SET last_access = ?, strength = MIN(strength * 1.1, 5) WHERE id = ?'),
      getMemory: this.db.prepare('SELECT * FROM memories WHERE id = ?'),
      listMemories: this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?'),
      listByScope: this.db.prepare('SELECT * FROM memories WHERE scope = ? ORDER BY updated_at DESC LIMIT ?'),
      deleteMemory: this.db.prepare('DELETE FROM memories WHERE id = ?'),
      // 版本化
      insertVersion: this.db.prepare(
        'INSERT INTO memory_versions (memory_id, revision, content, keywords, valid_from, valid_to, superseded_by) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
      ),
      closeVersion: this.db.prepare(
        'UPDATE memory_versions SET valid_to = ?, superseded_by = ? WHERE memory_id = ? AND valid_to IS NULL',
      ),
      versionsOf: this.db.prepare(
        'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY revision DESC LIMIT ?',
      ),
      // FTS（rowid 关联 memories 隐式 rowid）
      ftsInsert: this.db.prepare("INSERT INTO memories_fts (rowid, content) VALUES (?, ?)"),
      ftsDelete: this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?'),
      ftsSearch: this.db.prepare(
        `SELECT m.id, m.layer, m.type, m.scope, m.content, m.keywords, m.strength, m.created_at, m.updated_at, bm25(memories_fts) AS bm25
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? ORDER BY bm25 LIMIT ?`,
      ),
      // 图谱骨架
      upsertNode: this.db.prepare(
        'INSERT INTO nodes (id, kind, label, memory_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      ),
      insertEdge: this.db.prepare(
        'INSERT INTO edges (id, type, from_node, to_node, valid_from, valid_to, weight) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      ),
      neighbors: this.db.prepare(
        `SELECT n.id, n.kind, n.label, e.type AS edge_type, e.weight
         FROM edges e JOIN nodes n ON n.id = e.to_node
         WHERE e.from_node = ? AND e.valid_to IS NULL
         UNION ALL
         SELECT n.id, n.kind, n.label, e.type AS edge_type, e.weight
         FROM edges e JOIN nodes n ON n.id = e.from_node
         WHERE e.to_node = ? AND e.valid_to IS NULL`,
      ),
    }
  }

  /** 新增一条记忆。返回 id。 */
  add({ layer = 'sm', type = 'note', scope = 'global', content, keywords = [], strength = 1 }) {
    const id = `mem-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const kwJson = JSON.stringify([...new Set(keywords)])
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.stmt.insertMemory.run(id, layer, type, scope, content, kwJson, strength, now, now, now)
      const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id)
      this.stmt.ftsInsert.run(row.rowid, content)
      if (this.time) {
        this.stmt.insertVersion.run(id, 1, content, kwJson, now)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return id
  }

  /**
   * 更新记忆：time 开启 → 追加版本（旧版本隐藏）；关闭 → 直接覆盖。
   * 返回 { id, revision, superseded }。
   */
  update(id, { content, keywords = [], strengthDelta = 0 }) {
    const mem = this.stmt.getMemory.get(id)
    if (!mem) throw new Error(`memory ${id} not found`)
    const now = Date.now()
    const kwJson = JSON.stringify([...new Set(keywords)])
    const nextStrength = Math.min(5, mem.strength + strengthDelta)
    this.db.exec('BEGIN IMMEDIATE')
    let revision = mem.revision ?? 1
    try {
      if (this.time) {
        const prev = this.db.prepare('SELECT revision FROM memory_versions WHERE memory_id = ? AND valid_to IS NULL').get(id)
        if (prev) {
          revision = prev.revision + 1
          this.stmt.closeVersion.run(now, revision, id)
          this.stmt.insertVersion.run(id, revision, content, kwJson, now)
        } else {
          this.stmt.insertVersion.run(id, 1, content, kwJson, now)
        }
        // 滚动裁旧
        const extra = this.db.prepare(
          `SELECT id FROM memory_versions WHERE memory_id = ? AND id NOT IN (
             SELECT id FROM memory_versions WHERE memory_id = ? ORDER BY revision DESC LIMIT ?
           )`,
        ).all(id, id, this.maxVersions)
        const del = this.db.prepare('DELETE FROM memory_versions WHERE id = ?')
        for (const row of extra) del.run(row.id)
      }
      this.stmt.updateMemory.run(content, kwJson, nextStrength, now, id)
      const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id)
      this.stmt.ftsDelete.run(row.rowid)
      this.stmt.ftsInsert.run(row.rowid, content)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return { id, revision, superseded: revision > 1 }
  }

  /** 删除记忆（级联清版本/FTS/关联节点边）。 */
  forget(id) {
    const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id)
    if (!row) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.stmt.ftsDelete.run(row.rowid)
      this.stmt.deleteMemory.run(id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return true
  }

  get(id) {
    const mem = this.stmt.getMemory.get(id)
    if (!mem) return undefined
    mem.keywords = JSON.parse(mem.keywords)
    return mem
  }

  list({ scope, layer, limit = 50 } = {}) {
    const rows = scope
      ? this.db.prepare('SELECT * FROM memories WHERE scope = ? ORDER BY updated_at DESC LIMIT ?').all(scope, limit)
      : this.stmt.listMemories.all(limit)
    return rows.map((r) => ({ ...r, keywords: JSON.parse(r.keywords) }))
  }

  versions(id, limit = 10) {
    return this.stmt.versionsOf.all(id, limit)
  }

  /** FTS5 + 关键词 + 子串三路检索（阶段一；向量 RRF 属阶段二）。 */
  search(query, { scope, limit = 8, minScore = 0, excludeIds = [] } = {}) {
    const qTokens = tokenize(query)
    const excluded = new Set(excludeIds)
    // 路 1：FTS5 BM25（trigram 支持中文，但词须 >= 3 字符；2 字词走路 3）
    const ftsTerms = [...qTokens].filter((t) => t.length >= 3).slice(0, 12).map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
    const ftsHits = new Map()
    if (ftsTerms) {
      try {
        for (const row of this.stmt.ftsSearch.all(ftsTerms, 50)) {
          if (excluded.has(row.id)) continue
          if (scope && row.scope !== scope) continue
          // bm25 为负值（越小越好）→ 转正分
          ftsHits.set(row.id, { id: row.id, bm25: -row.bm25, kws: 0, sub: 0 })
        }
      } catch { /* 查询语法不合法时忽略 FTS 路 */ }
    }
    // 路 2+3：关键词交集 + 子串兜底（中文 2 字词、短查询）
    const likeQuery = query.replace(/[%_]/g, ' ').trim().slice(0, 50).toLowerCase()
    let kwHits = []
    if (qTokens.size > 0 || likeQuery) {
      const rows = scope
        ? this.db.prepare('SELECT * FROM memories WHERE scope = ?').all(scope)
        : this.db.prepare('SELECT * FROM memories').all()
      for (const r of rows) {
        if (excluded.has(r.id)) continue
        const kws = new Set(JSON.parse(r.keywords))
        let inter = 0
        for (const t of qTokens) if (kws.has(t)) inter++
        const sub = likeQuery && r.content.toLowerCase().includes(likeQuery) ? 1 : 0
        if (inter > 0 || sub > 0) {
          const existing = ftsHits.get(r.id)
          if (existing) {
            existing.kws = Math.max(existing.kws, inter)
            existing.sub = Math.max(existing.sub, sub)
          } else {
            kwHits.push({ id: r.id, bm25: 0, kws: inter, sub })
          }
        }
      }
    }
    const combined = [...ftsHits.values(), ...kwHits]
    // 融合评分：bm25 归一 + 关键词命中 + 子串命中
    const maxBm25 = combined.reduce((m, h) => Math.max(m, h.bm25), 0) || 1
    const scored = combined.map((h) => {
      const score = (h.bm25 / maxBm25) + h.kws * 0.5 + h.sub * 0.6
      return { ...h, score }
    })
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    const out = []
    for (const h of scored) {
      if (h.score < minScore) continue
      const mem = this.get(h.id)
      out.push({ ...mem, score: Number(h.score.toFixed(3)) })
      if (out.length >= limit) break
    }
    return out
  }

  /** 图谱骨架：为一条记忆建 entity 节点 + mentions 边。 */
  graphLink(memoryId, entityLabels) {
    if (!entityLabels || entityLabels.length < 2) return
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const nodeIds = []
      for (const label of entityLabels.slice(0, 8)) {
        const nid = `n-${randomUUID().slice(0, 8)}`
        this.stmt.upsertNode.run(nid, 'entity', label, memoryId, now)
        nodeIds.push(nid)
      }
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          this.stmt.insertEdge.run(`e-${randomUUID().slice(0, 8)}`, 'mentions', nodeIds[i], nodeIds[j], now, 1)
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  neighbors(nodeId) {
    return this.stmt.neighbors.all(nodeId, nodeId)
  }

  stats() {
    const r = this.db.prepare(
      'SELECT COUNT(*) AS total, SUM(layer = \'ep\') AS ep, SUM(layer = \'sm\') AS sm FROM memories',
    ).get()
    const versions = this.db.prepare('SELECT COUNT(*) AS c FROM memory_versions').get().c
    const nodes = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c
    const edges = this.db.prepare('SELECT COUNT(*) AS c FROM edges').get().c
    return {
      memories: r.total ?? 0,
      layers: { ep: r.ep ?? 0, sm: r.sm ?? 0 },
      versions,
      nodes,
      edges,
      timeDimension: this.time,
    }
  }

  close() {
    try { this.db.close() } catch { /* 已关闭 */ }
  }
}
