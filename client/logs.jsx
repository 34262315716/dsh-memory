/**
 * dsh-memory 客户端：记忆日志面板（v0.9.5）——背后运行了什么全透明。
 * 原 client/index.jsx 拆分（v0.10 解耦），轮询 /dsh-memory/logs。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
/** 记忆日志面板（v0.9.5）：背后运行了什么完全透明可见。
 *  轮询 /dsh-memory/logs，级别/事件筛选，自动滚动。 */
function MemoryLogPanel() {
  const [logs, setLogs] = useState([])
  const [level, setLevel] = useState("all")
  const [event, setEvent] = useState("all")
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState("")
  const listRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ limit: "200" })
      if (level !== "all") q.set("level", level)
      if (event !== "all") q.set("event", event)
      const res = await fetch("/dsh-memory/logs?" + q.toString())
      if (!res.ok) throw new Error("HTTP " + res.status)
      const j = await res.json()
      setLogs(j.logs ?? [])
      setError("")
    } catch (e) {
      setError(String(e?.message ?? e))
    }
  }, [level, event])
  useEffect(() => { void load() }, [load])
  // 3s 轮询（暂停时停止）
  useEffect(() => {
    if (paused) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [paused, load])
  // 新日志自动滚动到底（用户在顶部浏览时不打断——仅当接近底部时）
  useEffect(() => {
    const el = listRef.current
    if (el && el.scrollTop + el.clientHeight > el.scrollHeight - 80) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  const allEvents = [...new Set(logs.map((l) => l.event))]
  const levelColor = { info: "#7fb3d5", warn: "#e6b45c", error: "#e07b39" }
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "0 16px 16px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", flex: "none", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#aaa" }}>日志 {logs.length} 条 · 3s 自动刷新</span>
        <select value={level} onChange={(e) => setLevel(e.target.value)}
          style={{ padding: "2px 8px", fontSize: 12, borderRadius: 5, border: "1px solid #555", background: "#1a1a1a", color: "#ccc" }}>
          <option value="all">全部级别</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <select value={event} onChange={(e) => setEvent(e.target.value)}
          style={{ padding: "2px 8px", fontSize: 12, borderRadius: 5, border: "1px solid #555", background: "#1a1a1a", color: "#ccc" }}>
          <option value="all">全部事件</option>
          {allEvents.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <button onClick={() => setPaused((v) => !v)}
          style={{ padding: "2px 12px", borderRadius: 5, border: "1px solid #555", background: "transparent", color: "#ccc", cursor: "pointer", fontSize: 12 }}>
          {paused ? "继续" : "暂停"}
        </button>
        <button onClick={() => void load()}
          style={{ padding: "2px 12px", borderRadius: 5, border: "1px solid #555", background: "transparent", color: "#ccc", cursor: "pointer", fontSize: 12 }}>
          刷新
        </button>
      </div>
      {error ? <p style={{ fontSize: 12, color: "#e07b39" }}>加载失败：{error}</p> : null}
      <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", fontFamily: "monospace", fontSize: 11.5, lineHeight: 1.7 }}>
        {logs.length === 0 ? (
          <p style={{ color: "#777", padding: "20px 0", fontFamily: "inherit" }}>暂无日志（插件运行后自动记录写入/注入/检索/巡检/蒸馏）</p>
        ) : logs.map((l) => {
          let detail = l.detail
          try { const p = JSON.parse(l.detail); if (p && typeof p === "object") detail = JSON.stringify(p) } catch { /* 原文 */ }
          const t = new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })
          return (
            <div key={l.id} style={{ display: "flex", gap: 8, borderBottom: "1px solid #232323", padding: "3px 0" }}>
              <span style={{ color: "#666", flex: "none" }}>{t}</span>
              <span style={{ color: levelColor[l.level] ?? "#aaa", flex: "none", width: 42 }}>{l.level.toUpperCase()}</span>
              <span style={{ color: "#8ab4d8", flex: "none" }}>{l.event}</span>
              {l.scope ? <span style={{ color: "#6a9955", flex: "none" }}>({l.scope})</span> : null}
              <span style={{ color: "#ccc", wordBreak: "break-all" }}>{detail}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 侧边栏底部「记忆日志」入口：点开全视口毛玻璃面板（与图谱同款）。 */
export function MemoryLogLauncher({ wide }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
  return (
    <>
      <button type="button" onClick={() => setOpen((v) => !v)} title="记忆日志（运行全透明）"
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          padding: "5px 8px", borderRadius: 6, border: "none",
          background: open ? "rgba(224,123,57,0.18)" : "transparent",
          color: "#ccc", cursor: "pointer", fontSize: 12,
        }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M2 2h10v2H2zM2 6h10v2H2zM2 10h7v2H2z" fill="#e07b39" />
        </svg>
        {wide ? <span>记忆日志</span> : null}
      </button>
      {open ? (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(16, 16, 18, 0.72)",
          backdropFilter: "blur(22px) saturate(1.2)",
          WebkitBackdropFilter: "blur(22px) saturate(1.2)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{ display: "flex", alignItems: "center", padding: "44px 16px 10px", flex: "none", justifyContent: "space-between" }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: "#ddd", letterSpacing: 0.5 }}>记忆日志</span>
            <button type="button" onClick={() => setOpen(false)} title="关闭（Esc）"
              style={{ padding: "8px 22px", borderRadius: 10, cursor: "pointer", border: "1px solid rgba(255,255,255,0.22)", background: "rgba(255,255,255,0.08)", color: "#eee", fontSize: 13 }}>
              退出（Esc）
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            <MemoryLogPanel />
            <button type="button" onClick={() => setOpen(false)} title="关闭图谱（Esc）"
              style={{
                position: "absolute", left: 16, bottom: 16, zIndex: 10,
                padding: "8px 22px", borderRadius: 10, cursor: "pointer",
                border: "1px solid rgba(255,255,255,0.22)",
                background: "rgba(255,255,255,0.08)",
                backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
                color: "#eee", fontSize: 13, fontWeight: 500, letterSpacing: 0.5,
                boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
              }}
            >
              退出（Esc）
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

