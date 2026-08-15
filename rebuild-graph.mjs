// 一次性图谱重建：真嵌入（4096 维）迁移 + 节点归一化 + 语义 similarTo + before 时间链
import { MemoryStore, GRAPH_STOP_WORDS } from './lib/store.js'
import { RemoteEmbedder, cosine } from './lib/embedder.js'
import { createHash } from 'node:crypto'
import { readFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dbFile = join(homedir(), '.dsh', 'memory.db')
// 0. 再备份一次
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
copyFileSync(dbFile, dbFile + '.bak-graph-' + stamp)
console.log('backup: memory.db.bak-graph-' + stamp)

// 1. 真嵌入器（凭据文件读密钥，不回显）
const cred = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const key = (cred.match(/^MEMORY_EMBEDDING_API_KEY:\s*(\S+)/m) ?? [])[1]
if (!key) { console.error('no embedding key'); process.exit(1) }
const embedder = new RemoteEmbedder({ baseUrl: 'https://api.siliconflow.cn/v1', apiKey: key, model: 'Qwen/Qwen3-VL-Embedding-8B' })
await embedder.ready()
console.log('embedder ready, dim =', embedder.dim)

// 2. 打开库（构造时 256 → 4096 维度自动迁移）+ 全量重嵌入
const store = new MemoryStore(dbFile, { time: true, maxVersions: 8, embedder })
const before = store.stats()
console.log('BEFORE:', JSON.stringify(before))
const re = await store.reembedMissing(8)
console.log('reembed:', JSON.stringify(re))

// 3. 清空图（node_memories → edges → nodes）
store.db.exec('BEGIN IMMEDIATE')
try {
  store.db.exec('DELETE FROM node_memories')
  store.db.exec('DELETE FROM edges')
  store.db.exec('DELETE FROM nodes')
  store.db.exec('COMMIT')
} catch (e) { store.db.exec('ROLLBACK'); throw e }

const insNode = store.db.prepare('INSERT INTO nodes (id, kind, label, memory_id, created_at) VALUES (?, ?, ?, ?, ?)')
const insNM = store.db.prepare('INSERT OR IGNORE INTO node_memories (node_id, memory_id) VALUES (?, ?)')
const insEdge = store.db.prepare("INSERT INTO edges (id, type, from_node, to_node, valid_from, valid_to, weight) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET valid_to = NULL, weight = excluded.weight")
const now = Date.now()
const nidFor = (label) => 'n-' + createHash('sha1').update('norm|' + label.toLowerCase()).digest('hex').slice(0, 12)
const eidFor = (t, f, to) => 'e-' + createHash('sha1').update(t + '|' + f + '|' + to).digest('hex').slice(0, 12)

// 4. 归一化重建：label 向量余弦 ≥ 0.9 → 复用节点
const labelVec = new Map()
const labelNode = new Map()   // label -> nodeId
const mems = store.list({ limit: 1000 }).filter((m) => m.layer === 'sm' && m.type !== 'legacy')
let reused = 0, created = 0
for (const mem of mems) {
  const labels = [...new Set(mem.keywords)].filter((k) => k && !GRAPH_STOP_WORDS.has(k.toLowerCase())).slice(0, 8)
  if (labels.length < 2) continue
  const nodeIds = []
  for (const label of labels) {
    const keyL = label.toLowerCase()   // 归一化 key：大小写变体 = 同一实体
    let vec = labelVec.get(keyL)
    if (!vec) { [vec] = await embedder.embed([label]); labelVec.set(keyL, vec) }
    let target = null
    for (const [l, nid] of labelNode) {
      if (cosine(vec, labelVec.get(l)) >= 0.9) { target = nid; reused++; break }
    }
    if (!target) {
      target = nidFor(keyL)
      insNode.run(target, 'entity', label, mem.id, now)
      labelNode.set(keyL, target)
      created++
    }
    insNM.run(target, mem.id)
    nodeIds.push(target)
  }
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      insEdge.run(eidFor('mentions', nodeIds[i], nodeIds[j]), 'mentions', nodeIds[i], nodeIds[j], now, 1)
    }
  }
}
console.log('nodes: created=' + created + ' reused=' + reused + ' unique=' + labelNode.size)

// 5. similarTo：记忆内容向量两两余弦 ≥ 0.7（reembed 缓存命中，零额外 API 成本）
const pairs = []
for (let i = 0; i < mems.length; i++) {
  const [vi] = await embedder.embed([mems[i].content])
  for (let j = i + 1; j < mems.length; j++) {
    const [vj] = await embedder.embed([mems[j].content])
    const c = cosine(vi, vj)
    if (c >= 0.7) pairs.push([mems[i], mems[j], c])
  }
}
pairs.sort((a, b) => b[2] - a[2])
let simEdges = 0
for (const [a, b, c] of pairs) {
  // 记忆级单边（代表节点一条），避免节点集全连接爆炸
  simEdges += store.linkMemories(a.id, b.id, 'similarTo', Number(c.toFixed(4)))
}
console.log('similarTo 记忆对:', simEdges)
for (const [a, b, c] of pairs.slice(0, 8)) {
  console.log('  ' + c.toFixed(4) + ' | ' + a.content.slice(0, 40) + ' <-> ' + b.content.slice(0, 40))
}

// 6. before：归一化节点的记忆时间链
let beforeEdges = 0
for (const [, nid] of labelNode) {
  const ms = store.db.prepare('SELECT nm.memory_id AS id, m.created_at FROM node_memories nm JOIN memories m ON m.id = nm.memory_id WHERE nm.node_id = ? ORDER BY m.created_at').all(nid)
  for (let k = 0; k + 1 < ms.length; k++) {
    beforeEdges += store.linkMemories(ms[k].id, ms[k + 1].id, 'before', 1)
  }
}
console.log('before 链: ' + beforeEdges + ' 对')

// 7. 对比报告
const after = store.stats()
console.log('AFTER:', JSON.stringify(after))
console.log('=== 边类型分布 ===')
for (const r of store.db.prepare('SELECT type, COUNT(*) AS c, SUM(valid_to IS NULL) AS active FROM edges GROUP BY type').all()) {
  console.log('  ' + r.type + ': ' + r.c + ' (active ' + r.active + ')')
}
console.log('=== 归一化节点 label 列表（' + labelNode.size + ' 个） ===')
console.log('  ' + [...labelNode.keys()].join(' | '))
store.close()
console.log('DONE')
