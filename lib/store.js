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
import { createHash, randomUUID } from 'node:crypto'
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
  updated_at    INTEGER NOT NULL,
  theme         TEXT NOT NULL DEFAULT '',
  profile_aspect TEXT NOT NULL DEFAULT ''
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

CREATE TABLE IF NOT EXISTS communities (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL DEFAULT '',
  representative TEXT REFERENCES memories(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (community_id, node_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);

-- 阶段三：节点归一化后的多对多关联（一个实体节点可属于多条记忆）
CREATE TABLE IF NOT EXISTS node_memories (
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, memory_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_node_memories_mem ON node_memories(memory_id);

-- 阶段三⑥（图模型简化）：记忆级边独立表——一记忆一节点投影的一等数据源。
-- 8 型语义边直接落记忆对（不再绕实体代表节点）；实体 edges 表回归共现骨架（mentions）。
CREATE TABLE IF NOT EXISTS memory_links (
  from_memory TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('mentions', 'partOf', 'similarTo', 'causes', 'solves', 'before', 'supports', 'contradicts')),
  weight      REAL NOT NULL DEFAULT 1.0,
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER,
  PRIMARY KEY (from_memory, to_memory, type)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_memory);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_memory);

-- 阶段三⑥：键值元数据（管家巡检时间戳等跨重启状态）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- 阶段四（v0.9.0）：事件分类——时间连续 + 因果相关（同主题/共享实体）的记忆聚簇
-- 区别于 theme（语义相似）：事件是"过程"（时间维度），theme 是"内容"（语义维度）。
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL DEFAULT '',
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  representative TEXT REFERENCES memories(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS event_members (
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, memory_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_event_members_mem ON event_members(memory_id);
`

/** 余弦相似度（向量可能未归一化；本地实现避免与 embedder.js 循环依赖）。 */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

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

/** 图谱 8 型边（提案 §6）：mentions/partOf/similarTo/causes/solves/before/supports/contradicts。 */
export const EDGE_TYPES = new Set(['mentions', 'partOf', 'similarTo', 'causes', 'solves', 'before', 'supports', 'contradicts'])

/**
 * 图谱停用词：关键词 ≠ 实体，这些泛词不成节点。
 * 覆盖 tokenize 中文 bigram 泛词、LLM refiner 输出的完整泛词、英文虚词。
 */
export const GRAPH_STOP_WORDS = new Set([
  // 英文虚词/泛词
  'the', 'and', 'for', 'with', 'not', 'was', 'are', 'but', 'all', 'this', 'that',
  'these', 'those', 'from', 'has', 'have', 'had', 'been', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'must', 'into', 'over', 'only', 'more', 'most',
  'some', 'any', 'each', 'every', 'what', 'when', 'where', 'which', 'who', 'how', 'why',
  // 中文 bigram 泛词（tokenize 2 字滑动窗口产物）
  '阶段', '段一', '段二', '段三', '重启', '里程', '完成', '修复', '实现', '测试', '验证',
  '更新', '新增', '使用', '进行', '工作', '结果', '任务', '输出', '内容', '问题', '方案',
  '功能', '模块', '文件', '代码', '配置', '工具', '模型', '数据', '信息', '记录', '检查',
  '处理', '启动', '加载', '部署', '构建', '总结', '汇报', '讨论', '今天', '现在', '目前',
  '需要', '可以', '应该', '注意', '重要', '关键', '核心', '基础', '进阶', '版本', '时间',
  '世界', '历史', '当前', '默认', '相关', '其他', '所有', '全部', '部分', '每个', '这个',
  '那个', '我们', '他们', '用户', '项目', '本次', '后续', '之前', '之后', '以及', '还有',
  '另外', '总之', '比如', '例如', '没有', '已经', '这是', '就是', '一个', '什么', '怎么',
  '如何', '不是', '但是', '因为', '所以', '然后', '或者', '通过', '自己', '里面', '上面',
  '下面', '情况', '说明', '报告', '整理', '关闭', '打开', '开启', '继续', '开始', '结束',
  '支持', '安装', '收尾', '落地', '链路', '闭环', '搞定',
  // 中文虚词/碎片 bigram（规则 tokenize 产物，非实体）
  '的想', '想法', '法我', '我是', '是赞', '赞成', '成的', '你的', '以及', '还是',
  '或者', '因为', '所以', '但是', '不是', '就是', '一种', '什么', '怎么', '没有',
  '已经', '如果', '那么', '这样', '那样', '这些', '那些', '自己', '我们', '他们',
  '你们', '她们', '它', '她', '他', '我', '你', '有', '是', '在', '和', '的', '了',
  // LLM refiner 输出的完整泛词
  '阶段一', '阶段二', '阶段三', '阶段四', '质量改进', '语义记忆', '设计方案', '记忆系统',
  '记忆插件', '记忆', '系统', '插件', '最终', '进展情况', '工作记忆', '上下文', '过程',
])

/** 确定性节点 id：同 (memory, label) → 同节点（幂等建图的前提）。 */
function nodeIdFor(memoryId, label) {
  return `n-${createHash('sha1').update(`${memoryId}|${label}`).digest('hex').slice(0, 12)}`
}

/** 确定性边 id：同 (type, from, to) → 同边（幂等，重复建边 no-op）。 */
function edgeIdFor(fromNode, toNode, type) {
  return `e-${createHash('sha1').update(`${type}|${fromNode}|${toNode}`).digest('hex').slice(0, 12)}`
}

export class MemoryStore {
  /**
   * @param {string} dbFile SQLite 文件路径
   * @param {object} opts { time: boolean, maxVersions: number }
   */
  constructor(dbFile, opts = {}) {
    this.time = opts.time ?? true
    this.maxVersions = opts.maxVersions ?? 8
    this.embedder = opts.embedder ?? null       // Embedder seam（rule/remote/onnx）；null = 同步 rule 兜底
    this.reranker = opts.reranker ?? null       // Reranker seam（可空）
    const rk = opts.rerankCfg ?? {}             // rerank 融合参数（RRF 后精排）
    this.rerankTopK = rk.topK ?? 20             // 精排候选数
    this.rerankMinCandidates = rk.minCandidates ?? 3  // 候选不足不重排
    this.rerankRrfWeight = rk.rrfWeight ?? 0.7  // final = w×norm(rrf) + (1-w)×rerank
    this.vecDim = opts.vecDim ?? this.embedder?.dim ?? VEC_DIM
    this.vecEnabled = false
    this.db = new DatabaseSync(dbFile, { allowExtension: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    // 旧库补列：主题聚类字段 + 画像子域字段（ALTER 失败仅警告，不影响功能）
    try {
      const cols = this.db.prepare('PRAGMA table_info(memories)').all()
      if (!cols.some((c) => c.name === 'theme')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN theme TEXT NOT NULL DEFAULT ''")
        console.log('[dsh-memory] memories 表补列 theme（主题聚类）')
      }
      if (!cols.some((c) => c.name === 'profile_aspect')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN profile_aspect TEXT NOT NULL DEFAULT ''")
        console.log('[dsh-memory] memories 表补列 profile_aspect（画像子域）')
      }
    } catch (err) {
      console.warn('[dsh-memory] theme/profile_aspect 列检测失败: ' + err.message)
    }
    // 阶段二：sqlite-vec 向量扩展（加载失败优雅降级为纯 FTS/关键词）
    try {
      this.db.loadExtension(getLoadablePath())
      // 维度迁移：仅注入 embedder 时显式迁移（重建空表 + reembedMissing 重嵌入）；
      // 无 embedder（测试/临时脚本）沿用现有表维度，避免误清生产库向量。
      const curDim = this.#vectorTableDim()
      if (curDim !== null && curDim !== this.vecDim) {
        if (this.embedder) {
          this.db.exec('DROP TABLE memory_vectors')
          console.log(`[dsh-memory] 向量维度迁移 ${curDim} → ${this.vecDim}（重建空表，待重嵌入）`)
        } else {
          this.vecDim = curDim
        }
      }
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(embedding float[${this.vecDim}])`)
      this.vecEnabled = true
    } catch (err) {
      this.vecEnabled = false
      console.warn(`[dsh-memory] sqlite-vec 加载失败，向量检索降级为纯 FTS5/关键词: ${err.message}`)
    }
    this.#prepare()
    this.#migrateMemoryLinks()
  }

  /** 读取现有 vec0 表维度（无表返回 null）。 */
  #vectorTableDim() {
    try {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'").get()
      const m = row?.sql?.match(/float\[(\d+)\]/)
      return m ? Number(m[1]) : null
    } catch {
      return null
    }
  }

  /** 统一嵌入入口：embedder 优先，失败抛错由调用方降级。 */
  async embedTexts(texts) {
    if (this.embedder) return await this.embedder.embed(texts)
    return texts.map((t) => Array.from(ruleEmbed(t, this.vecDim)))
  }

  /** 阶段三④：批量补写缺失向量（维度迁移后/嵌入失败后的重嵌入）。返回 { done, pending }。 */
  async reembedMissing(batchSize = 16) {
    if (!this.vecEnabled) return { done: 0, pending: 0, reason: 'vector disabled' }
    const rows = this.db.prepare(
      'SELECT m.rowid, m.content FROM memories m LEFT JOIN memory_vectors v ON v.rowid = m.rowid WHERE v.rowid IS NULL',
    ).all()
    let done = 0
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      let vecs
      try {
        vecs = await this.embedTexts(batch.map((r) => r.content))
      } catch (err) {
        console.warn(`[dsh-memory] 重嵌入批次失败（${i}..${i + batch.length}）: ${err.message}`)
        continue
      }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (let k = 0; k < batch.length; k++) {
          this.stmt.vecInsert.run(BigInt(batch[k].rowid), JSON.stringify(vecs[k]))
        }
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
      done += batch.length
    }
    return { done, pending: rows.length - done }
  }

  /**
   * 阶段三：主题聚类（记忆级）——用嵌入向量做凝聚聚类，主题标签写回 memories.theme。
   * 与图社区（节点级 label propagation）互补：theme 是「记忆条目归类」，社区是「知识节点聚类」。
   * @param {number} threshold 余弦凝聚阈值（默认 0.78）
   * @returns {Promise<{label: string, members: string[]}[]>}
   */
  async themeMemories(threshold = 0.78) {
    const rows = this.db.prepare('SELECT id, content, keywords FROM memories ORDER BY rowid').all()
    if (rows.length < 2) return []
    let vecs
    try {
      vecs = await this.embedTexts(rows.map((r) => r.content))
    } catch {
      return []
    }
    const cos = (a, b) => {
      let d = 0, na = 0, nb = 0
      for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
      return d / (Math.sqrt(na) * Math.sqrt(nb) || 1)
    }
    // 贪心凝聚：每条记忆并入最相似簇（簇质心 = 成员向量均值），否则开新簇
    const clusters = []
    for (let i = 0; i < rows.length; i++) {
      const v = vecs[i]
      let best = -1, bestSim = 0
      for (let c = 0; c < clusters.length; c++) {
        const sim = cos(v, clusters[c].centroid)
        if (sim > bestSim) { bestSim = sim; best = c }
      }
      if (best >= 0 && bestSim >= threshold) {
        const cl = clusters[best]
        const n = cl.members.length + 1
        for (let d = 0; d < cl.centroid.length; d++) cl.centroid[d] = (cl.centroid[d] * (n - 1) + v[d]) / n
        cl.members.push(rows[i])
      } else {
        clusters.push({ members: [rows[i]], centroid: v.slice() })
      }
    }
    // 主题标签：簇内关键词高频（非停用词）top2；**频次 ≥2 才入选**——
    // 单成员簇的 bigram 碎片词（"但这"/"个插"）频次恒为 1，过滤后 label 为空 → 图谱节点兜底 type
    const out = []
    const upd = this.db.prepare('UPDATE memories SET theme = ? WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const cl of clusters) {
        const wc = new Map()
        for (const m of cl.members) {
          let kws = []
          try { kws = JSON.parse(m.keywords) } catch { /* 忽略坏 keywords */ }
          for (const k of kws) {
            const kl = k.toLowerCase()
            if (!GRAPH_STOP_WORDS.has(kl)) wc.set(kl, (wc.get(kl) ?? 0) + 1)
          }
        }
        const label = [...wc.entries()]
          .filter(([, c]) => c >= 2)                    // 频次门槛：滤碎片词
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 2).map(([w]) => w).join('/')
        for (const m of cl.members) upd.run(label, m.id)
        out.push({ label, members: cl.members.map((m) => m.id) })
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return out
  }

  #prepare() {
    this.stmt = {
      insertMemory: this.db.prepare(
        'INSERT INTO memories (id, layer, type, scope, content, keywords, strength, last_access, created_at, updated_at, profile_aspect) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      updateAspect: this.db.prepare('UPDATE memories SET profile_aspect = ? WHERE id = ?'),
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
      // UPSERT：重复连边 no-op 式重新激活（valid_to 置 NULL 恢复历史边）并更新权重
      insertEdge: this.db.prepare(
        'INSERT INTO edges (id, type, from_node, to_node, valid_from, valid_to, weight) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET valid_to = NULL, weight = excluded.weight',
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
      // 记忆级边（memory_links）
      memoryLinkUpsert: this.db.prepare(
        'INSERT INTO memory_links (from_memory, to_memory, type, weight, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(from_memory, to_memory, type) DO UPDATE SET valid_to = NULL, weight = excluded.weight',
      ),
      memoryLinkDeactivate: this.db.prepare(
        'UPDATE memory_links SET valid_to = ? WHERE from_memory = ? AND to_memory = ? AND type = ? AND valid_to IS NULL',
      ),
      memoryLinkDelete: this.db.prepare('DELETE FROM memory_links WHERE from_memory = ? OR to_memory = ?'),
    }
  }

  /** 实体节点 → 所属记忆（node_memories 优先，fallback nodes.memory_id）。 */
  #memoryOfNode(nodeId) {
    const via = this.db.prepare('SELECT memory_id FROM node_memories WHERE node_id = ? LIMIT 1').get(nodeId)
    if (via) return via.memory_id
    return this.db.prepare('SELECT memory_id FROM nodes WHERE id = ?').get(nodeId)?.memory_id ?? null
  }

  /** 启动迁移（幂等增量）：旧实体图上的记忆级边（similarTo/before）→ memory_links。
   *  每条检查 memory_links 是否已有同三元组，已迁移/历史边跳过——重复启动不重复插入，
   *  后续写入 edges 的旧式边也能被补迁（v0.8.0 用行数 n>0 早退，残留边永不重迁移）。 */
  #migrateMemoryLinks() {
    try {
      const rows = this.db.prepare(
        "SELECT e.type, e.weight, e.from_node, e.to_node FROM edges e WHERE e.valid_to IS NULL AND e.type IN ('similarTo', 'before')",
      ).all()
      if (rows.length === 0) return
      const existing = new Set(this.db.prepare(
        "SELECT from_memory || '|' || to_memory || '|' || type AS k FROM memory_links",
      ).all().map((r) => r.k))
      let migrated = 0
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const r of rows) {
          const a = this.#memoryOfNode(r.from_node)
          const b = this.#memoryOfNode(r.to_node)
          if (a && b && a !== b && !existing.has(`${a}|${b}|${r.type}`)) {
            this.stmt.memoryLinkUpsert.run(a, b, r.type, r.weight, Date.now())
            existing.add(`${a}|${b}|${r.type}`)
            migrated++
          }
        }
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
      if (migrated > 0) console.log(`[dsh-memory] 图谱迁移：实体边 → memory_links ${migrated} 条`)
    } catch (err) {
      console.warn(`[dsh-memory] memory_links 迁移失败（不影响主流程）: ${err.message}`)
    }
  }

  /** 新增一条记忆。返回 id。 */
  async add({ layer = 'sm', type = 'note', scope = 'global', content, keywords = [], strength = 1, aspect = '' }) {
    const id = `mem-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const kwJson = JSON.stringify([...new Set(keywords)])
    // 嵌入在事务外（网络调用不持写锁）；失败留待 reembedMissing 补写
    let vec = null
    if (this.vecEnabled) {
      try { [vec] = await this.embedTexts([content]) } catch { /* 不阻断主流程 */ }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.stmt.insertMemory.run(id, layer, type, scope, content, kwJson, strength, now, now, now, aspect)
      const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id)
      this.stmt.ftsInsert.run(row.rowid, content)
      if (vec) {
        // 向量写入失败（如维度不匹配）不阻断记忆落库，留待 reembedMissing 补写
        try {
          this.stmt.vecInsert.run(BigInt(row.rowid), JSON.stringify(vec))
        } catch (err) {
          console.warn(`[dsh-memory] vector write skipped for ${id}: ${err.message}`)
        }
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
  async update(id, { content, keywords = [], strengthDelta = 0 }) {
    const mem = this.stmt.getMemory.get(id)
    if (!mem) throw new Error(`memory ${id} not found`)
    const now = Date.now()
    const kwJson = JSON.stringify([...new Set(keywords)])
    const nextStrength = Math.min(5, mem.strength + strengthDelta)
    // 嵌入在事务外（网络调用不持写锁）
    let vec = null
    if (this.vecEnabled) {
      try { [vec] = await this.embedTexts([content]) } catch { /* 失败留待补写 */ }
    }
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
        if (vec) {
          // 向量写入失败（如维度不匹配）不阻断记忆更新，留待 reembedMissing 补写
          try {
            this.stmt.vecInsert.run(BigInt(row.rowid), JSON.stringify(vec))
          } catch (err) {
            console.warn(`[dsh-memory] vector write skipped for ${id}: ${err.message}`)
          }
        }
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
    const where = []
    const args = []
    if (scope) { where.push('scope = ?'); args.push(scope) }
    if (layer) { where.push('layer = ?'); args.push(layer) }
    const sql = `SELECT * FROM memories${where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...args, limit)
    return rows.map((r) => ({ ...r, keywords: JSON.parse(r.keywords) }))
  }

  versions(id, limit = 10) {
    return this.stmt.versionsOf.all(id, limit)
  }

  /**
   * 阶段三：世界线回滚——把指定 revision 重新激活为当前切片（时间旅行）。
   * 语义（提案 §17.3）：当前活跃版 valid_to 置为 now；目标版本快照追加为新 revision
   * （世界线不销毁、不断链）；活跃切片/FTS/向量同步为目标内容。
   * @returns {{ id: string, revision: number, restoredFrom: number }}
   */
  async rollback(id, revision) {
    const mem = this.stmt.getMemory.get(id)
    if (!mem) throw new Error(`memory ${id} not found`)
    if (!this.time) throw new Error('time dimension disabled (features.time = false)')
    const target = this.db.prepare(
      'SELECT * FROM memory_versions WHERE memory_id = ? AND revision = ?',
    ).get(id, revision)
    if (!target) throw new Error(`revision ${revision} not found for ${id}`)
    // 嵌入在事务外（网络调用不持写锁）
    let vec = null
    if (this.vecEnabled) {
      try { [vec] = await this.embedTexts([target.content]) } catch { /* 失败留待补写 */ }
    }
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 1) 关闭当前活跃版（valid_to = now，superseded_by = 目标 revision）
      this.db.prepare(
        'UPDATE memory_versions SET valid_to = ?, superseded_by = ? WHERE memory_id = ? AND valid_to IS NULL',
      ).run(now, revision, id)
      // 2) 重新激活目标版本：追加为新 revision（内容快照自目标版本）
      const nextRev = this.db.prepare(
        'SELECT MAX(revision) AS m FROM memory_versions WHERE memory_id = ?',
      ).get(id).m + 1
      const kws = JSON.parse(target.keywords)
      this.stmt.insertVersion.run(id, nextRev, target.content, JSON.stringify(kws), now)
      // 3) 同步活跃切片 + FTS + 向量（与 update 一致）
      this.stmt.updateMemory.run(target.content, JSON.stringify(kws), mem.strength, now, id)
      const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id)
      this.stmt.ftsDelete.run(row.rowid)
      this.stmt.ftsInsert.run(row.rowid, target.content)
      if (this.vecEnabled) {
        this.stmt.vecDelete.run(BigInt(row.rowid))
        if (vec) {
          // 向量写入失败（如维度不匹配）不阻断回滚，留待 reembedMissing 补写
          try {
            this.stmt.vecInsert.run(BigInt(row.rowid), JSON.stringify(vec))
          } catch (err) {
            console.warn(`[dsh-memory] vector write skipped for ${id}: ${err.message}`)
          }
        }
      }
      this.db.exec('COMMIT')
      return { id, revision: nextRev, restoredFrom: revision }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
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
  async search(query, { scope, limit = 8, minScore = 0, excludeIds = [] } = {}) {
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
    // 阶段三④：向量路（KNN 余弦，embedder seam）+ 三路 RRF 融合
    let vecHits = []
    if (this.vecEnabled) {
      try {
        const [qvecRaw] = await this.embedTexts([query])
        const qvec = JSON.stringify(qvecRaw)
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
    // 三路并集（修复：向量独有命中此前丢失——scored 只覆盖 FTS+关键词路）
    const byId = new Map(combined.map((h) => [h.id, h]))
    const scored = [...new Set([...byId.keys(), ...vecHits.map((h) => h.id)])].map((id) => {
      const h = byId.get(id)
      return h
        ? { ...h, score: rrf.get(id) ?? 0 }
        : { id, bm25: 0, kws: 0, sub: 0, score: rrf.get(id) ?? 0 }
    })
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    // reranker 后置精排（阶段三④期4）：RRF topK 候选 → 重排 → 融合分；失败/关闭 → 原 RRF 顺序（零损失）
    if (this.reranker && scored.length >= this.rerankMinCandidates) {
      try {
        const top = scored.slice(0, this.rerankTopK)
        const docs = []
        const docIds = []
        for (const h of top) {
          const m = this.get(h.id)
          if (m?.content) { docs.push(m.content); docIds.push(h.id) }
        }
        if (docs.length >= this.rerankMinCandidates) {
          const res = await this.reranker.rerank(query, docs)
          const rr = new Map(res.map((r) => [docIds[r.index], Number(r.score) ?? 0]))
          const maxRrf = Math.max(...scored.map((h) => h.score), 1e-9)
          for (const h of scored) {
            const rs = rr.get(h.id)
            if (rs === undefined) continue
            const norm = h.score / maxRrf
            h.score = this.rerankRrfWeight * norm + (1 - this.rerankRrfWeight) * Math.max(0, Math.min(1, rs))
          }
          scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        }
      } catch (err) {
        console.warn(`[dsh-memory] reranker 失败，降级 RRF 顺序: ${err.message}`)
      }
    }
    const out = []
    for (const h of scored) {
      if (h.score < minScore) continue
      const mem = this.get(h.id)
      out.push({ ...mem, score: Number(h.score.toFixed(4)) })
      if (out.length >= limit) break
    }
    // 访问加成：命中的记忆记 last_access + strength 加成（遗忘曲线语义——此前 touchMemory 无调用点，
    // last_access 冻结在创建时间，老化报告实为"创建年龄"，热门旧记忆会被误报为老化候选）
    if (out.length > 0) {
      try {
        const now = Date.now()
        const touch = this.stmt.touchMemory
        for (const h of out) touch.run(now, h.id)
      } catch { /* 访问记录失败不影响检索 */ }
    }
    return out
  }

  /** 图谱：为一条记忆建 entity 节点 + 同记忆内全连接边（幂等：同 label+记忆 → 同节点/边）。 */
  graphLink(memoryId, entityLabels, edgeType = 'mentions') {
    // 实体过滤：去重 + 停用词（关键词 ≠ 实体；泛词不成节点）
    const labels = [...new Set(entityLabels ?? [])]
      .filter((l) => l && !GRAPH_STOP_WORDS.has(l.toLowerCase()))
    if (labels.length < 2) return
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const nodeIds = []
      for (const label of labels.slice(0, 8)) {
        const nid = nodeIdFor(memoryId, label)
        this.stmt.upsertNode.run(nid, 'entity', label, memoryId, now)
        nodeIds.push(nid)
      }
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          this.stmt.insertEdge.run(edgeIdFor(nodeIds[i], nodeIds[j], edgeType), edgeType, nodeIds[i], nodeIds[j], now, 1)
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** 阶段三⑥（简化）：记忆级连边（8 型）——写 memory_links 表，一记忆对一条边。
   *  幂等（同三元组 UPSERT 重新激活 + 更新权重）；记忆删除级联清理。
   *  返回 1 = 边已处于活跃（新建或重新激活）；0 = 自连/记忆不存在。 */
  link(fromMemoryId, toMemoryId, type, weight = 1) {
    if (!EDGE_TYPES.has(type)) throw new Error(`unknown edge type: ${type}`)
    if (fromMemoryId === toMemoryId) return 0
    const n = this.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE id IN (?, ?)').get(fromMemoryId, toMemoryId).c
    if (n !== 2) return 0
    this.stmt.memoryLinkUpsert.run(fromMemoryId, toMemoryId, type, weight, Date.now())
    return 1
  }

  /** 阶段三⑥：断开记忆间 type 边（memory_links valid_to 置为 now，历史保留不销毁）。返回断开条数。 */
  unlink(fromMemoryId, toMemoryId, type) {
    if (!EDGE_TYPES.has(type)) throw new Error(`unknown edge type: ${type}`)
    return this.stmt.memoryLinkDeactivate.run(Date.now(), fromMemoryId, toMemoryId, type).changes
  }

  /** 阶段三：similarTo 自动边（去重候选：相似但未达合并阈值）。权重 = 相似度。 */
  linkSimilar(memoryAId, memoryBId, similarity) {
    return this.link(memoryAId, memoryBId, 'similarTo', Math.max(0, Math.min(1, similarity)))
  }

  /** 阶段三⑥：记忆级单边（写 memory_links；不再依赖实体代表节点——无实体节点也能连边）。 */
  linkMemories(fromMemoryId, toMemoryId, type, weight = 1) {
    return this.link(fromMemoryId, toMemoryId, type, weight)
  }

  /**
   * 阶段三：before 时间链自动边——**记忆级**（不依赖节点归属）：
   * 与该记忆共享 label 的其他记忆按时间排序，时间最近的前驱/后继连记忆级单边。
   * 修复：旧实现按 nodes.memory_id 排序，归一化节点（多记忆共享）的时间被代表记忆顶替，
   * 导致 1/3 的 before 边方向错误（审计发现 11/32）。
   */
  linkBefore(memoryId) {
    const mem = this.db.prepare('SELECT created_at FROM memories WHERE id = ?').get(memoryId)
    if (!mem) return 0
    // 该记忆的实体 label 集合（归一化节点经 node_memories；否则 fallback nodes.memory_id）
    const labels = this.db.prepare(
      `SELECT DISTINCT n.label FROM node_memories nm JOIN nodes n ON n.id = nm.node_id
       WHERE nm.memory_id = ? AND n.kind = 'entity'`,
    ).all(memoryId).map((r) => r.label)
    if (labels.length === 0) {
      for (const r of this.db.prepare("SELECT DISTINCT label FROM nodes WHERE memory_id = ? AND kind = 'entity'").all(memoryId)) labels.push(r.label)
    }
    if (labels.length === 0) return 0
    let n = 0
    for (const label of labels) {
      // 共享同 label 的其他记忆（记忆级时间），排序后取最近前驱/后继
      // 优先 node_memories 路径；空则 fallback nodes.memory_id（测试/未归一化场景）
      let peers = this.db.prepare(
        `SELECT DISTINCT nm.memory_id AS id, m.created_at FROM node_memories nm
         JOIN memories m ON m.id = nm.memory_id
         JOIN nodes n2 ON n2.id = nm.node_id
         WHERE n2.label = ? AND nm.memory_id != ? ORDER BY m.created_at, nm.memory_id`,
      ).all(label, memoryId)
      if (peers.length === 0) {
        peers = this.db.prepare(
          `SELECT m.id AS id, m.created_at FROM nodes n JOIN memories m ON m.id = n.memory_id
           WHERE n.label = ? AND n.memory_id != ? AND n.kind = 'entity' ORDER BY m.created_at, m.id`,
        ).all(label, memoryId)
      }
      let pred = null
      for (const p of peers) {
        if (p.created_at <= mem.created_at) pred = p
        else break
      }
      const succ = peers.find((p) => p.created_at > mem.created_at) ?? null
      if (pred) n += this.linkMemories(pred.id, memoryId, 'before', 1)
      if (succ) n += this.linkMemories(memoryId, succ.id, 'before', 1)
    }
    return n
  }

  /** 阶段三：记忆的节点列表（归一化后经 node_memories 关联） / 节点详情。 */
  nodesOfMemory(memoryId) {
    const via = this.db.prepare(
      'SELECT n.* FROM node_memories nm JOIN nodes n ON n.id = nm.node_id WHERE nm.memory_id = ? ORDER BY n.created_at',
    ).all(memoryId)
    if (via.length > 0) return via
    return this.db.prepare('SELECT * FROM nodes WHERE memory_id = ? ORDER BY created_at').all(memoryId)
  }

  getNode(nodeId) {
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId)
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

  /** 阶段二：从一条记忆出发的 k-hop 邻域（其关联节点的邻居并集；归一化节点经 node_memories）。 */
  memoryNeighbors(memoryId, hops = 2) {
    let nodeRows = this.db.prepare('SELECT node_id AS id FROM node_memories WHERE memory_id = ?').all(memoryId)
    if (nodeRows.length === 0) {
      nodeRows = this.db.prepare('SELECT id FROM nodes WHERE memory_id = ?').all(memoryId)
    }
    const seen = new Map()
    for (const nr of nodeRows) {
      for (const n of this.neighborsK(nr.id, hops)) {
        if (!seen.has(n.id)) seen.set(n.id, n)
      }
    }
    return [...seen.values()]
  }

  /** 阶段三⑥（简化）：记忆级邻域——沿 memory_links 活跃边双向 k-hop 扩散。返回 { id, type, depth }。 */
  memoryLinkNeighbors(memoryId, hops = 2) {
    const edgeStmt = this.db.prepare(
      'SELECT from_memory AS a, to_memory AS b, type FROM memory_links WHERE valid_to IS NULL AND (from_memory = ? OR to_memory = ?)',
    )
    const out = []
    const seen = new Set([memoryId])
    let frontier = [{ id: memoryId, depth: 0 }]
    for (let d = 0; d < hops; d++) {
      const next = []
      for (const f of frontier) {
        for (const e of edgeStmt.all(f.id, f.id)) {
          const nbr = e.a === f.id ? e.b : e.a
          if (seen.has(nbr)) continue
          seen.add(nbr)
          out.push({ id: nbr, type: e.type, depth: f.depth + 1 })
          next.push({ id: nbr, depth: f.depth + 1 })
        }
      }
      frontier = next
      if (frontier.length === 0) break
    }
    return out
  }

  /** 阶段三⑥（简化）：记忆级最短路径（BFS，沿 memory_links 活跃边双向）。返回记忆序列与边类型链，或 null。 */
  memoryPath(fromId, toId, maxLen = 6) {
    if (fromId === toId) return { nodes: [fromId], edges: [] }
    const edgeStmt = this.db.prepare(
      'SELECT from_memory AS a, to_memory AS b, type FROM memory_links WHERE valid_to IS NULL AND (from_memory = ? OR to_memory = ?)',
    )
    const visited = new Set([fromId])
    let frontier = [{ node: fromId, trail: { nodes: [fromId], edges: [] } }]
    for (let depth = 0; depth < maxLen; depth++) {
      const next = []
      for (const { node, trail } of frontier) {
        for (const e of edgeStmt.all(node, node)) {
          const nbr = e.a === node ? e.b : e.a
          if (visited.has(nbr)) continue
          visited.add(nbr)
          const t = { nodes: [...trail.nodes, nbr], edges: [...trail.edges, e.type] }
          if (nbr === toId) return t
          next.push({ node: nbr, trail: t })
        }
      }
      frontier = next
      if (frontier.length === 0) break
    }
    return null
  }

  /**
   * 阶段二：社区检测（label propagation，轻量适配小图）。
   * 重写 communities/community_members 表，返回社区列表。
   */
  detectCommunities(iterations = 15) {
    const nodes = this.db.prepare('SELECT id, label, memory_id FROM nodes').all()
    if (nodes.length < 2) {
      this.db.exec('DELETE FROM community_members')
      this.db.exec('DELETE FROM communities')
      return []
    }
    const adj = new Map(nodes.map((n) => [n.id, new Set()]))
    for (const e of this.db.prepare('SELECT from_node, to_node FROM edges WHERE valid_to IS NULL').all()) {
      adj.get(e.from_node)?.add(e.to_node)
      adj.get(e.to_node)?.add(e.from_node)
    }
    let labels = new Map(nodes.map((n) => [n.id, n.id]))
    for (let it = 0; it < iterations; it++) {
      let changed = false
      for (const n of nodes) {
        const counts = new Map()
        for (const nb of adj.get(n.id) ?? []) {
          const l = labels.get(nb)
          counts.set(l, (counts.get(l) ?? 0) + 1)
        }
        let best = labels.get(n.id)
        let bestC = 0
        for (const [l, c] of counts) {
          if (c > bestC || (c === bestC && l < best)) { best = l; bestC = c }
        }
        if (best !== labels.get(n.id)) { labels.set(n.id, best); changed = true }
      }
      if (!changed) break
    }
    // 归组 → 重写表
    const groups = new Map()
    for (const n of nodes) {
      const l = labels.get(n.id)
      if (!groups.has(l)) groups.set(l, [])
      groups.get(l).push(n)
    }
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM community_members')
      this.db.exec('DELETE FROM communities')
      const insC = this.db.prepare('INSERT INTO communities (id, label, representative, created_at) VALUES (?, ?, ?, ?)')
      const insM = this.db.prepare('INSERT INTO community_members (community_id, node_id) VALUES (?, ?)')
      const out = []
      for (const [root, members] of groups) {
        if (members.length < 2) continue
        const cid = `c-${randomUUID().slice(0, 8)}`
        // 社区 label：成员节点最常见的词
        const wordCounts = new Map()
        for (const m of members) {
          const words = members.find((x) => x.id === m.id)?.label
          for (const w of tokenize(words ?? '')) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1)
        }
        const topWords = [...wordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w)
        const representative = members[0]?.memory_id ?? null
        insC.run(cid, topWords.join('/'), representative, now)
        for (const m of members) insM.run(cid, m.id)
        out.push({ id: cid, label: topWords.join('/'), members: members.map((m) => m.label) })
      }
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** 阶段二：社区列表（含成员与代表记忆）。 */
  communities() {
    const rows = this.db.prepare('SELECT * FROM communities ORDER BY created_at DESC').all()
    return rows.map((c) => ({
      ...c,
      members: this.db.prepare(
        'SELECT n.label FROM community_members cm JOIN nodes n ON n.id = cm.node_id WHERE cm.community_id = ?',
      ).all(c.id).map((m) => m.label),
    }))
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

  /** 阶段三⑥（管家①）：全局去重扫描——sm 记忆两两余弦（嵌入缓存命中），返回近重复候选（不自动合并）。 */
  async dedupScan(threshold = 0.92, limit = 20) {
    const rows = this.db.prepare("SELECT id, content FROM memories WHERE layer = 'sm' ORDER BY rowid").all()
    if (rows.length < 2) return []
    let vecs
    try {
      vecs = await this.embedTexts(rows.map((r) => r.content))
    } catch (err) {
      console.warn(`[dsh-memory] dedupScan 嵌入失败: ${err.message}`)
      return []
    }
    const out = []
    for (let i = 0; i < rows.length && out.length < limit; i++) {
      for (let j = i + 1; j < rows.length && out.length < limit; j++) {
        const sim = cosine(vecs[i], vecs[j])
        if (sim >= threshold) {
          out.push({ a: rows[i].id, b: rows[j].id, sim: Number(sim.toFixed(4)), aContent: rows[i].content, bContent: rows[j].content })
        }
      }
    }
    return out
  }

  /** 阶段三⑥（管家②）：老化报告——创建超 agingDays 天且未访问的记忆（strength 已衰减/低价值候选），不删除。 */
  agingReport(days = 30, limit = 20) {
    const now = Date.now()
    const cutoff = now - days * 24 * 3600 * 1000
    return this.db.prepare(
      `SELECT id, layer, type, content, strength, last_access, created_at FROM memories
       WHERE created_at < ? AND last_access < ? ORDER BY strength ASC, last_access ASC LIMIT ?`,
    ).all(cutoff, cutoff, limit).map((r) => ({
      ...r,
      idleDays: Math.round((now - r.last_access) / (24 * 3600 * 1000)),
    }))
  }

  /**
   * 阶段三⑥（管家③）：一键巡检——去重扫描 + 老化报告。
   * dryRun=false 时自动合并 sim ≥ autoMergeThreshold（默认 0.95，几乎重复）的对：
   * target = strength 高者（内容更长者优先），source 并入后删除。返回 { duplicates, aging, merged }。
   */
  async housekeeping({ dedupThreshold = 0.92, agingDays = 30, dryRun = true, autoMergeThreshold = 0.95, limit = 20 } = {}) {
    const duplicates = await this.dedupScan(dedupThreshold, limit)
    const aging = this.agingReport(agingDays, limit)
    let merged = 0
    if (!dryRun && duplicates.length > 0) {
      const mergedIds = new Set()
      for (const d of duplicates) {
        if (mergedIds.has(d.a) || mergedIds.has(d.b)) continue
        if (d.sim < autoMergeThreshold) continue
        const a = this.get(d.a)
        const b = this.get(d.b)
        if (!a || !b) continue
        // target：强度高者；同强度取内容更长者
        const target = (a.strength > b.strength || (a.strength === b.strength && a.content.length >= b.content.length)) ? a : b
        const source = target.id === a.id ? b : a
        const mergedContent = `${target.content}\n---\n${source.content}`.slice(0, 2000)
        await this.update(target.id, {
          content: mergedContent,
          keywords: [...new Set([...target.keywords, ...source.keywords])].slice(0, 60),
          strengthDelta: 0.3,
        })
        this.forget(source.id)
        mergedIds.add(target.id)
        mergedIds.add(source.id)
        merged++
      }
    }
    return { duplicates, aging, merged }
  }

  /** 阶段三⑥：读取键值元数据（无则返回 undefined）。 */
  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
  }

  /** 阶段三⑥：写入键值元数据（UPSERT）。 */
  setMeta(key, value) {
    this.db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value))
  }

  /**
   * 阶段四（v0.9.0）：事件检测——时间线扫描（纯 rule，无 LLM）。
   * sm 记忆按 created_at 排序；相邻两条「时间间隔 < gapMs」且「同 theme（非空）或共享实体（node_memories 交集）」
   * → 归入同一事件；否则切新事件（单条记忆自成一事件，保证每记忆必属一事件）。
   * 全量重建 events/event_members；事件 id = ev-首成员记忆 id（重建稳定）。
   * 返回 [{ id, label, startAt, endAt, count }]。
   */
  detectEvents(gapMs = 2 * 3600 * 1000) {
    const rows = this.db.prepare(
      "SELECT id, theme, type, created_at FROM memories WHERE layer = 'sm' ORDER BY created_at, id",
    ).all()
    // 实体映射：memory -> Set<label>（共享实体判定——实体节点是记忆私有的（id 含 memoryId），
    // 记忆间共享实体应比 label；归一化节点（node_memories）与普通路径（nodes.memory_id）都并入）
    const nodeMems = new Map()
    const addLabel = (memId, label) => {
      if (!memId || !label) return
      if (!nodeMems.has(memId)) nodeMems.set(memId, new Set())
      nodeMems.get(memId).add(label)
    }
    for (const r of this.db.prepare(
      'SELECT nm.memory_id, n.label FROM node_memories nm JOIN nodes n ON n.id = nm.node_id',
    ).all()) addLabel(r.memory_id, r.label)
    for (const r of this.db.prepare("SELECT memory_id, label FROM nodes WHERE kind = 'entity'").all()) addLabel(r.memory_id, r.label)
    const shareEntity = (a, b) => {
      const sa = nodeMems.get(a), sb = nodeMems.get(b)
      if (!sa || !sb) return false
      for (const n of sa) if (sb.has(n)) return true
      return false
    }
    const sameTheme = (a, b) => Boolean(a && b && a === b)
    // 时间线扫描：相邻聚簇
    const groups = []
    for (const r of rows) {
      const cur = groups[groups.length - 1]
      const prev = cur?.members[cur.members.length - 1]
      const close = prev && (r.created_at - prev.created_at) < gapMs
      const related = prev && (sameTheme(r.theme, prev.theme) || shareEntity(r.id, prev.id))
      if (close && related) cur.members.push(r)
      else groups.push({ members: [r] })
    }
    const now = Date.now()
    const insEvent = this.db.prepare('INSERT INTO events (id, label, start_at, end_at, representative, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const insMember = this.db.prepare('INSERT INTO event_members (event_id, memory_id) VALUES (?, ?)')
    const out = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM event_members')
      this.db.exec('DELETE FROM events')
      for (const g of groups) {
        const first = g.members[0]
        const last = g.members[g.members.length - 1]
        const id = `ev-${first.id}`
        // label：成员非空 theme 众数（并列取字典序小者）；无 → 首成员 type
        const themeCounts = new Map()
        for (const m of g.members) if (m.theme) themeCounts.set(m.theme, (themeCounts.get(m.theme) ?? 0) + 1)
        let label = ''
        let bestC = 0
        for (const [t, c] of themeCounts) {
          if (c > bestC || (c === bestC && t < label)) { bestC = c; label = t }
        }
        if (!label) label = first.type
        insEvent.run(id, label, first.created_at, last.created_at, first.id, now)
        for (const m of g.members) insMember.run(id, m.id)
        out.push({ id, label, startAt: first.created_at, endAt: last.created_at, count: g.members.length })
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return out
  }

  /** 阶段四（v0.9.0）：事件列表（含成员摘要，按时间倒序）。 */
  events(limit = 20) {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY start_at DESC LIMIT ?').all(limit)
    const memStmt = this.db.prepare(
      'SELECT m.id, m.content, m.type FROM event_members em JOIN memories m ON m.id = em.memory_id WHERE em.event_id = ? ORDER BY m.created_at',
    )
    return rows.map((e) => {
      const members = memStmt.all(e.id).map((m) => ({ id: m.id, type: m.type, content: m.content }))
      return {
        id: e.id,
        label: e.label,
        startAt: e.start_at,
        endAt: e.end_at,
        representative: e.representative,
        count: members.length,
        members,
      }
    })
  }

  /** 阶段四（v0.9.1）：before 边方向修正——from 应早于 to（时间演化链）；
   *  倒挂边（from 晚于 to）断开并重建正确方向；同时间戳无法判定方向的保持不动。返回修正条数。 */
  fixBeforeDirections() {
    const rows = this.db.prepare(
      "SELECT from_memory, to_memory FROM memory_links WHERE type = 'before' AND valid_to IS NULL",
    ).all()
    const getAt = this.db.prepare('SELECT created_at FROM memories WHERE id = ?')
    let fixed = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        const f = getAt.get(r.from_memory)
        const t = getAt.get(r.to_memory)
        if (!f || !t || f.created_at <= t.created_at) continue
        // 倒挂：断开旧方向，重建正确方向（before 是派生数据，重建安全）
        this.stmt.memoryLinkDeactivate.run(Date.now(), r.from_memory, r.to_memory, 'before')
        this.stmt.memoryLinkUpsert.run(r.to_memory, r.from_memory, 'before', 1, Date.now())
        fixed++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return fixed
  }

  /** 阶段四（v0.9.0）：记忆 → 事件 id 映射（供图谱快照 nodes.eventId）。 */
  eventMap() {
    const m = new Map()
    for (const r of this.db.prepare('SELECT event_id, memory_id FROM event_members').all()) {
      m.set(r.memory_id, r.event_id)
    }
    return m
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
      vector: this.vecEnabled,
      rerank: Boolean(this.reranker),
    }
  }

  close() {
    try { this.db.close() } catch { /* 已关闭 */ }
  }
}
