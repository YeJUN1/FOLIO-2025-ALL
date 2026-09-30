import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 一键构建编排：generate.js（生成/下载）→ process.js（规范化 + Draco 压缩）
 * 用法:
 *   npm run garden:build                     # 生成全部 enabled 资产并规范化压缩
 *   npm run garden:build -- --mock           # 零成本全链路演练（mock 源冒充生成结果）
 *   npm run garden:build -- --only moonGate  # 只处理指定资产
 *   npm run garden:build -- --force          # 强制重新生成（忽略已下载结果）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const getFlag = name => args.includes(`--${name}`)
const getValue = name => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null }

const only = getValue('only')

const generateArgs = []
if(getFlag('mock'))
    generateArgs.push('--mock')
if(getFlag('force'))
    generateArgs.push('--force')
if(only)
    generateArgs.push('--only', only)

const processArgs = [ '--compress' ]
if(only)
    processArgs.push('--only', only)

function run(_label, _script, _scriptArgs)
{
    console.log(`\n== ${_label} ==`)
    const result = spawnSync(process.execPath, [ path.join(__dirname, _script), ..._scriptArgs ], { stdio: 'inherit' })

    if(result.status !== 0)
    {
        console.error(`✘ ${_label} 失败（退出码 ${result.status ?? 'signal'}），已中止`)
        process.exit(result.status || 1)
    }
}

run('生成 generate.js', 'generate.js', generateArgs)
run('规范化 process.js', 'process.js', processArgs)

console.log('\n✔ 构建完成：static/garden/ 已更新（编辑 scene.json 摆放后 npm run dev 查看）')
