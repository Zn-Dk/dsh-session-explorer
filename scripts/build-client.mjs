/**
 * build-client.mjs —— 用 rolldown 把 src/client/bundle-entry.ts 打包成 lib/client.js。
 *
 * 硬约束（与 CLIENT_BUNDLE 参考一致）：
 * - 产物必须是单文件 ModuleLoader 格式：首行
 *   window.__ModuleLoader__.load({ id: "dsh-session-explorer", factory: (require) => {
 * - react / react-dom / react/jsx-runtime / @deepseek-ai/dsh-client-ui-primitives 等
 *   platform seed 词保持 external（运行时由 loader 注入的 require 解答）
 * - @xyflow/react 及其依赖内联
 * - CJS 输出的 intro 必须提供 module/exports（浏览器没有 CommonJS 全局）
 * - 产物最后一行必须是 } });
 *
 * rolldown 会把 banner/footer 当作代码转换（补分号等），破坏首行契约，
 * 所以 header/footer 在构建后手工拼接；intro 走 output.intro（纯声明语句，转换安全）。
 *
 * 失败时抛错终止（prepack 依赖它）。
 */

import { build } from 'rolldown'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src', 'client', 'bundle-entry.ts')
const outfile = join(root, 'lib', 'client.js')

const ID = 'dsh-session-explorer'
const HEADER = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(ID) + ', factory: (require) => {'
const FOOTER = 'return factory(require); } });'
// CJS 输出在浏览器运行，必须自己提供 module/exports（官方 tsdown preset 同款 intro）。
const INTRO = 'var module = { exports: {} }; var exports = module.exports;'

// platform seed words（与 packages/client/web/src/seed.ts 一致）
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

async function main() {
  mkdirSync(dirname(outfile), { recursive: true })

  const mode = process.env.NODE_ENV ?? 'production'
  const envObject = { MODE: mode }

  const result = await build({
    input: { client: entry },
    cwd: root,
    // 关键：loader 注入的 require 解答 seed 词；其余全部内联
    external: EXTERNALS,
    platform: 'browser',
    transform: {
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode),
        // zustand/immer 探测 import.meta.env：rolldown 需要同时 define 三档
        'import.meta': JSON.stringify({ env: envObject }),
        'import.meta.env': JSON.stringify(envObject),
        'import.meta.env.MODE': JSON.stringify(mode),
      },
    },
    moduleTypes: {
      '.css': 'text',
    },
    output: {
      format: 'cjs',
      intro: INTRO,
      entryFileNames: 'client.js',
    },
    logLevel: 'info',
  })

  const outputs = result.output
  const chunk = outputs.find((item) => item.type === 'chunk')
  if (!chunk || chunk.type !== 'chunk') {
    throw new Error('client bundle build produced no JS chunk')
  }
  const code = HEADER + '\n' + chunk.code + '\n' + FOOTER

  // 格式断言：单文件 ModuleLoader 契约
  if (!code.startsWith(HEADER)) {
    throw new Error('client bundle header assertion failed')
  }
  if (!code.trimEnd().endsWith('} });')) {
    throw new Error('client bundle footer assertion failed')
  }
  if (code.includes('require("@xyflow/react")')) {
    throw new Error('client bundle inline assertion failed: @xyflow/react leaked as an external require')
  }
  // @xyflow/react 官方基础 CSS 必须内联进 bundle（moduleTypes text 把 css 变字符串，
  // bundle-entry 注入 <style>）。缺失会整画布崩坏——0.2.0 隐藏入口事故的根因。
  if (!code.includes('--xy-node-border-radius') && !code.includes('.react-flow__minimap')) {
    throw new Error('client bundle css assertion failed: @xyflow/react dist/style.css not inlined (canvas would render broken)')
  }
  // rolldown 可能把 intro 重写成等价形式：var exports = { exports: {} }.exports
  const introOk = chunk.code.includes('var module = { exports: {} }')
    || chunk.code.includes('var exports = { exports: {} }')
  if (!introOk) {
    throw new Error('client bundle intro assertion failed: CJS module/exports intro missing (browser would throw "module is not defined")')
  }

  writeFileSync(outfile, code)
  console.log('[build-client] wrote ' + outfile + ' (' + Buffer.byteLength(code) + ' bytes)')
}

main().catch((error) => {
  console.error('[build-client] FAILED:', error)
  process.exit(1)
})
