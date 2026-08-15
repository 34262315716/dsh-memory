/** CDP：导航设置→插件，检查记忆插件卡片真实状态。 */
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
  await sleep(2500)
  // 展开侧边栏 + 点设置 + 点插件 tab
  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='打开侧边栏'); if(b) b.click(); return 1 })()`)
  await sleep(1000)
  const clickedSet = await evalJs(`(() => { const el=[...document.querySelectorAll('button,a,[role="menuitem"]')].find(e=>{const t=(e.getAttribute('aria-label')||e.textContent||'').trim(); return /设置|Settings/.test(t)&&t.length<12}); if(el){el.click();return (el.getAttribute('aria-label')||el.textContent).trim()} return 'none' })()`)
  console.log('点设置:', clickedSet)
  await sleep(1200)
  const clickedTab = await evalJs(`(() => { const el=[...document.querySelectorAll('button,[role="tab"]')].find(e=>(e.textContent||'').trim()==='插件'); if(el){el.click();return '插件'} return 'none' })()`)
  console.log('点插件tab:', clickedTab)
  await sleep(1500)
  const body = await evalJs(`document.body.innerText`)
  const i = body.indexOf('插件配置')
  const seg = body.slice(Math.max(0, i - 30), Math.min(body.length, i + 900)).replace(/\n+/g, ' | ')
  console.log('\n=== 插件配置页内容 ===')
  console.log(seg)
  console.log('\n内存卡片状态:', /记忆插件设置不可用/.test(body) ? '不可用' : (/记忆插件设置加载中/.test(body) ? '加载中' : (/注入最大/.test(body) ? '✅ 正常显示表单' : '未见卡片')))
  ws.close()
  process.exit(0)
})
ws.on('error', (e) => { console.error('WS 错误:', e.message); process.exit(1) })
