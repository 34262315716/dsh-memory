/**
 * 构建 dsh-memory 的 client bundle（浏览器端设置卡片）。
 * 输出 lib/client.js，格式与 DSH 官方 client bundle 一致：
 *   window.__ModuleLoader__.load({ id, factory: (require) => {...} })
 * externals（@deepseek-ai/*、react、react/jsx-runtime）由 web 端 module table 提供。
 */
import { writeFileSync } from 'node:fs'
// esbuild 优先从依赖解析（开源/CI 走 devDependencies）。
// 作者本机曾经硬编码一条 file:///D:/AItool/... 的绝对路径兜底——那违反本文档纪律
// （禁止本机绝对路径入库），而且换机器就断。改成显式环境变量：谁的本机谁自己指。
let build
try {
  ;({ build } = await import('esbuild'))
} catch (e) {
  const fallback = process.env.DSH_MEMORY_ESBUILD
  if (!fallback) {
    console.error('❌ 找不到 esbuild。请在仓库根执行 `npm install`（推荐），')
    console.error('   或把 esbuild 的 lib/main.js 绝对路径写进环境变量 DSH_MEMORY_ESBUILD 后重试。')
    throw e
  }
  ;({ build } = await import(pathToFileURL(fallback).href))
}
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(root, 'client', 'index.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime'],
  write: false,
  logLevel: 'warning',
})

const code = result.outputFiles[0].text
// 去掉 esbuild 的顶层 "use strict"（放进 factory 后无效且会报错）与行尾分号冗余，保留其余
const body = code.replace(/^"use strict";\s*/, '')
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`
const out = join(root, 'lib', 'client.js')
writeFileSync(out, wrapped)
console.log(`✅ client bundle 已生成: ${out} (${wrapped.length} bytes)`)
