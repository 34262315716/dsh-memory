/**
 * dsh-memory 存储层：嵌入式 SQLite（node:sqlite，零编译）。
 *
 * 单库结构（WAL + STRICT + user_version 迁移）：
 *   - memories          记忆身份 + 活跃切片（id 跨版本不变）
 *   - memory_versions   版本历史（世界线：valid_from/valid_to/superseded_by/revision）
 *   - memories_fts      FTS5（trigram tokenizer，原生支持中文子串）
 *   - memory_vectors    sqlite-vec vec0 虚拟表（阶段二：向量 KNN；扩展加载失败自动降级）
 *   - nodes / edges     图谱骨架（阶段一：mentions 共现边）
 *
 * 时间维度（worldline）：time 开关开启时，更新 = 追加版本 + 更新活跃切片，
 * 旧版本保留但隐藏（valid_to 非空，不参与检索/注入）。
 */

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { getLoadablePath } from 'sqlite-vec'

/** 向量维度（哈希 embedding；换模型维度时重建向量表即可）。 */
export const VEC_DIM = 256

/**
 * 规则 embedding（离线零依赖）：tokenize 后每个 token 哈希到两个槽位，归一化。
 * 同一批 token 产生确定性向量；相似文本产生相近向量（余弦）。
 */
export function ruleEmbed(text, dim = VEC_DIM) {
  const vec = new Float32Array(dim)
  const tokens = tokenize(text)
  for (const t of tokens) {
    // FNV-1a 双哈希（两个槽位，降低碰撞）
    let h = 2166136261
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    vec[Math.abs(h) % dim] += 1
    let h2 = h ^ (h >>> 16)
    h2 = Math.imul(h2, 0x85ebca6b)
    vec[Math.abs(h2) % dim] += 0.5
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) vec[i] /= norm
  return vec
}

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
    this.vecDim = opts.vecDim ?? VEC_DIM
    this.vecEnabled = false
    this.db = new DatabaseSync(dbFile, { allowExtension: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    // 阶段二：sqlite-vec 向量扩展（加载失败优雅降级为纯 FTS/关键词）
    try {
      this.db.loadExtension(getLoadablePath())
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(embedding float[${this.vecDim}])`)
      this.vecEnabled = true
    } catch (err) {
      this.vecEnabled = false
      console.warn(`[dsh-memory] sqlite-vec 加载失败，向量检索降级为纯 FTS5/关键词: ${err.message}`)
    }
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
      // 向量（vec0 虚拟表；rowid 与 memories 隐式 rowid 对齐）
      vecInsert: this.db.prepare('INSERT INTO memory_vectors(rowid, embedding) VALUES (?, ?)'),
      vecUpdate: this.db.prepare('UPDATE memory_vectors SET embedding = ? WHERE rowid = ?'),
      vecDelete: this.db.prepare('DELETE FROM memory_vectors WHERE rowid = ?'),
      vecSearch: this.db.prepare(
        `SELECT v.rowid, v.distance FROM memory_vectors v
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
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
      if (this.vecEnabled) {
        this.stmt.vecInsert.run(BigInt(row.rowid), JSON.stringify([...ruleEmbed(content, this.vecDim)]))
      }
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
      if (this.vecEnabled) {
        this.stmt.vecDelete.run(BigInt(row.rowid))
        this.stmt.vecInsert.run(BigInt(row.rowid), JSON.stringify([...ruleEmbed(content, this.vecDim)]))
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return { id, revision, superseded: revision > 1 }
  }

  /** 删除记忆（级联清版本/FTS/向量/关联节点边）。 */
  forget(id) {
    const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id)
    if (!row) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.stmt.ftsDelete.run(row.rowid)
      if (this.vecEnabled) this.stmt.vecDelete.run(BigInt(row.rowid))
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

  /** 阶段二：清空某 scope（或全部）的记忆（级联 FTS/向量/版本/节点边）。 */
  purge(scope) {
    const rows = scope
      ? this.db.prepare('SELECT rowid FROM memories WHERE scope = ?').all(scope)
      : this.db.prepare('SELECT rowid FROM memories').all()
    if (rows.length === 0) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        this.stmt.ftsDelete.run(r.rowid)
        if (this.vecEnabled) this.stmt.vecDelete.run(BigInt(r.rowid))
      }
      const n = scope
        ? this.db.prepare('DELETE FROM memories WHERE scope = ?').run(scope).changes
        : this.db.prepare('DELETE FROM memories').run().changes
      this.db.exec('COMMIT')
      return n
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
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
    // 阶段二：向量路（KNN 余弦）+ 三路 RRF 融合
    let vecHits = []
    if (this.vecEnabled) {
      try {
        const qvec = JSON.stringify([...ruleEmbed(query, this.vecDim)])
        const rows = this.stmt.vecSearch.all(qvec, 50)
        const rowidToId = new Map()
        for (const r of rows) {
          const mem = this.db.prepare('SELECT id FROM memories WHERE rowid = ?').get(r.rowid)
          if (mem) rowidToId.set(r.rowid, mem.id)
        }
        vecHits = rows
          .filter((r) => rowidToId.has(r.rowid) && !excluded.has(rowidToId.get(r.rowid)))
          .map((r) => ({ id: rowidToId.get(r.rowid), cosDistance: r.distance }))
      } catch { /* 向量路失败静默降级 */ }
    }
    // RRF：每条路给 rank 分（1/(60+rank)），三路求和
    const rankScore = (arr, field) => {
      const m = new Map()
      arr.forEach((h, i) => m.set(h.id, 1 / (60 + i + 1)))
      return m
    }
    const ftsRank = rankScore([...combined].sort((a, b) => b.bm25 - a.bm25))
    const kwRank = rankScore([...combined].sort((a, b) => b.kws - a.kws || b.sub - a.sub))
    const vecRank = rankScore(vecHits)
    const rrf = new Map()
    const addRrf = (map) => {
      for (const [id, s] of map) rrf.set(id, (rrf.get(id) ?? 0) + s)
    }
    addRrf(ftsRank)
    addRrf(kwRank)
    addRrf(vecRank)
    const scored = combined.map((h) => ({ ...h, score: rrf.get(h.id) ?? 0 }))
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    const out = []
    for (const h of scored) {
      if (h.score < minScore) continue
      const mem = this.get(h.id)
      out.push({ ...mem, score: Number(h.score.toFixed(4)) })
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

  /** 阶段二：k-hop 邻域扩散（递归 CTE，正向遍历，去重）。 */
  neighborsK(nodeId, hops = 2) {
    const rows = this.db.prepare(`
      WITH RECURSIVE hop(n, depth) AS (
        SELECT e.to_node, 1 FROM edges e WHERE e.from_node = ? AND e.valid_to IS NULL
        UNION
        SELECT e.to_node, hop.depth + 1 FROM edges e JOIN hop ON e.from_node = hop.n
        WHERE hop.depth < ?
      )
      SELECT DISTINCT n.id, n.kind, n.label, h.depth
      FROM hop h JOIN nodes n ON n.id = h.n
      ORDER BY h.depth, n.id
    `).all(nodeId, hops)
    return rows
  }

  /** 阶段二：最短路径查询（BFS，正向+反向边）。返回节点序列与边类型链，或 null。 */
  path(fromId, toId, maxLen = 6) {
    if (fromId === toId) return { nodes: [fromId], edges: [] }
    const visited = new Set([fromId])
    let frontier = [{ node: fromId, trail: { nodes: [fromId], edges: [] } }]
    for (let depth = 0; depth < maxLen; depth++) {
      const next = []
      for (const { node, trail } of frontier) {
        const nbrs = this.stmt.neighbors.all(node, node)
        for (const n of nbrs) {
          if (visited.has(n.id)) continue
          visited.add(n.id)
          const t = { nodes: [...trail.nodes, n.id], edges: [...trail.edges, n.edge_type] }
          if (n.id === toId) return t
          next.push({ node: n.id, trail: t })
        }
      }
      frontier = next
      if (frontier.length === 0) break
    }
    return null
  }

  /** 阶段二：从一条记忆出发的 k-hop 邻域（其关联节点的邻居并集）。 */
  memoryNeighbors(memoryId, hops = 2) {
    const nodeRows = this.db.prepare('SELECT id FROM nodes WHERE memory_id = ?').all(memoryId)
    const seen = new Map()
    for (const nr of nodeRows) {
      for (const n of this.neighborsK(nr.id, hops)) {
        if (!seen.has(n.id)) seen.set(n.id, n)
      }
    }
    return [...seen.values()]
  }

  /**
   * 阶段二：遗忘曲线惰性衰减——超过 24h 未访问的记忆按指数衰减
   * （strength *= exp(-decayRatePerDay × days)），最低保留 0.1。
   */
  decayExpired(now = Date.now(), decayRatePerDay = 0.15) {
    const rows = this.db.prepare(
      'SELECT id, strength, last_access FROM memories WHERE last_access < ?',
    ).all(now - 24 * 3600 * 1000)
    if (rows.length === 0) return 0
    const stmt = this.db.prepare('UPDATE memories SET strength = ? WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    let n = 0
    try {
      for (const r of rows) {
        const days = (now - r.last_access) / (24 * 3600 * 1000)
        const next = Math.max(0.1, r.strength * Math.exp(-decayRatePerDay * days))
        if (next !== r.strength) {
          stmt.run(next, r.id)
          n++
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return n
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
