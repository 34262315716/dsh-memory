/** CDP：查插件列表里 dsh-memory / dsh-auto-memory / vision-toolkit 的状态。 */
import WebSocket from 'file:///C:/Users/28643/.dsh/profiles/node_modules/ws/wrapper.mjs'

const wsUrl = process.argv[2]
const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
let id = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
})

ws.on('open', async () => {
  await send('Runtime.enable')
  await sleep(1500)
  await evalJs(`(() => { const el=[...document.querySelectorAll('button,[role="tab"]')].find(e=>(e.textContent||'').trim()==='插件列表'); if(el) el.click(); return 1 })()`)
  await sleep(1500)
  const body = await evalJs(`document.body.innerText`)
  for (const kw of ['dsh-memory', 'dsh-auto-memory', 'vision-toolkit', 'memory']) {
    const idx = body.indexOf(kw)
    if (idx >= 0) {
      console.log(`✅ 找到 "${kw}":`, body.slice(Math.max(0, idx - 20), idx + 60).replace(/\n+/g, ' | '))
    } else {
      console.log(`❌ 未找到 "${kw}"`)
    }
  }
  // 也查整个插件列表后半段
  const i = body.indexOf('插件列表')
  console.log('\n=== 插件列表尾部 ===')
  console.log(body.slice(i, i + 1500).replace(/\n+/g, ' | '))
  ws.close()
  process.exit(0)
})
ws.on('error', (e) => { console.error('WS 错误:', e.message); process.exit(1) })
