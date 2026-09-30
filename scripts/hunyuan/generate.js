import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ai3d } from 'tencentcloud-sdk-nodejs-ai3d'

/**
 * 混元生3D 生成编排：提交任务 → 轮询 → 下载 GLB 到 resources/hunyuan-raw/
 * 用法:
 *   node scripts/hunyuan/generate.js                 # 生成 manifest 中所有 enabled 资产
 *   node scripts/hunyuan/generate.js --only key1,key2   # 只处理指定资产(可含未启用)
 *   node scripts/hunyuan/generate.js --force            # 重新生成（忽略已下载结果）
 *   node scripts/hunyuan/generate.js --mock             # 用本地 GLB 冒充结果，零成本测全链路
 *   node scripts/hunyuan/generate.js --list             # 查看当前状态
 *   node scripts/hunyuan/generate.js --transport cam|tokenhub  # 传输通道（默认：有 TOKENHUB_API_KEY 用 tokenhub）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')

const args = process.argv.slice(2)
const getFlag = name => args.includes(`--${name}`)
const getValue = name => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null }

const options = {
    mock: getFlag('mock'),
    force: getFlag('force'),
    list: getFlag('list'),
    transport: getValue('transport'),
    only: getValue('only') ? getValue('only').split(',').map(s => s.trim()) : null
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'))
const statePath = path.join(__dirname, 'state.json')
const rawDirectory = path.join(projectRoot, 'resources', 'hunyuan-raw')
const mockSource = path.join(projectRoot, 'resources', 'models', 'sudo.glb')

const POLL_INTERVAL = 15 * 1000
const POLL_TIMEOUT = 60 * 60 * 1000
const JOB_EXPIRY = 23 * 60 * 60 * 1000
const MAX_CONCURRENT = 3
const TOKENHUB_BASE_URL = process.env.TOKENHUB_BASE_URL || 'https://tokenhub.tencentmaas.com'

const sleep = duration => new Promise(resolve => setTimeout(resolve, duration))
const rawPath = key => path.join(rawDirectory, `${key}.glb`)

const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { assets: {} }
state.assets = state.assets || {}
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 4))

function getAssets()
{
    let assets = manifest.assets.filter(asset => asset.enabled)

    if(options.only)
    {
        const missing = options.only.filter(key => !manifest.assets.some(asset => asset.key === key))
        if(missing.length)
        {
            console.error(`✘ manifest 中不存在这些 key: ${missing.join(', ')}`)
            process.exit(1)
        }
        assets = manifest.assets.filter(asset => options.only.includes(asset.key))
    }

    return assets
}

function createClient()
{
    const secretId = process.env.TENCENTCLOUD_SECRET_ID
    const secretKey = process.env.TENCENTCLOUD_SECRET_KEY

    if(!secretId || !secretKey)
    {
        console.error('✘ 缺少腾讯云密钥。请在项目根目录 .env 中配置：')
        console.error('    TENCENTCLOUD_SECRET_ID=你的SecretId')
        console.error('    TENCENTCLOUD_SECRET_KEY=你的SecretKey')
        console.error('  （可先用 --mock 零成本跑通全链路）')
        process.exit(1)
    }

    return new ai3d.v20250513.Client({
        credential: { secretId, secretKey },
        region: process.env.TENCENTCLOUD_REGION || 'ap-guangzhou'
    })
}

function createTransport()
{
    const transport = options.transport || (process.env.TOKENHUB_API_KEY ? 'tokenhub' : 'cam')

    if(transport === 'tokenhub')
    {
        if(!process.env.TOKENHUB_API_KEY)
        {
            console.error('✘ 缺少 TokenHub API Key。请在项目根目录 .env 中配置：')
            console.error('    TOKENHUB_API_KEY=你的API Key')
            console.error('  获取方式：腾讯云控制台 → 混元生3D「立即接入」→ 创建 API KEY（需主账号）')
            console.error('  （也可用 --transport cam 回退到 SecretId/SecretKey 云 API）')
            process.exit(1)
        }

        console.log(`传输通道: TokenHub（${TOKENHUB_BASE_URL}）`)
        return { submit: tokenhubSubmit, query: tokenhubQuery }
    }

    const client = createClient()
    console.log(`传输通道: 云 API（SecretId/SecretKey · region ${process.env.TENCENTCLOUD_REGION || 'ap-guangzhou'}）`)
    return {
        submit: asset => submit(client, asset),
        query: (asset, jobId) => query(client, asset, jobId)
    }
}

function getAction(asset)
{
    return (asset.action || manifest.defaults.action) === 'rapid' ? 'rapid' : 'pro'
}

function buildSubmitParams(asset, action)
{
    const defaults = manifest.defaults
    const params = { Prompt: asset.prompt }

    const enablePBR = asset.enablePBR ?? defaults.enablePBR
    if(typeof enablePBR !== 'undefined')
        params.EnablePBR = enablePBR

    if(action === 'pro')
    {
        params.Model = asset.model || defaults.model || '3.0'
        params.GenerateType = asset.generateType || defaults.generateType || 'Normal'

        const faceCount = asset.faceCount ?? defaults.faceCount
        if(faceCount && params.GenerateType === 'Normal')
            params.FaceCount = faceCount
    }

    return params
}

async function submit(client, asset)
{
    const action = getAction(asset)
    const params = buildSubmitParams(asset, action)
    const response = action === 'pro'
        ? await client.SubmitHunyuanTo3DProJob(params)
        : await client.SubmitHunyuanTo3DRapidJob(params)

    return response.JobId
}

async function query(client, asset, jobId)
{
    const action = getAction(asset)
    return action === 'pro'
        ? await client.QueryHunyuanTo3DProJob({ JobId: jobId })
        : await client.QueryHunyuanTo3DRapidJob({ JobId: jobId })
}

/* ------------------------------------------------------------------ *
 * TokenHub 传输通道（新平台，Bearer API Key 鉴权）
 * 文档：《混元调用指南》 https://cloud.tencent.com/document/product/1823/130082
 * ------------------------------------------------------------------ */

function tokenhubModel(asset)
{
    const action = getAction(asset)
    if(action === 'rapid')
        return 'hy-3d-express'

    return `hy-3d-${asset.model || manifest.defaults.model || '3.0'}`
}

function buildTokenHubParams(asset)
{
    const defaults = manifest.defaults
    const action = getAction(asset)
    const params = { model: tokenhubModel(asset), prompt: asset.prompt }

    if(action === 'pro')
    {
        const generateType = asset.generateType || defaults.generateType || 'Normal'
        params.generate_type = generateType

        const faceCount = asset.faceCount ?? defaults.faceCount
        if(faceCount && generateType === 'Normal')
            params.face_count = faceCount
    }

    const enablePBR = asset.enablePBR ?? defaults.enablePBR
    if(typeof enablePBR !== 'undefined')
        params.enable_pbr = enablePBR

    return params
}

async function tokenhubRequest(endpoint, body)
{
    const response = await fetch(`${TOKENHUB_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.TOKENHUB_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    })

    const payload = await response.json().catch(() => null)
    if(!response.ok || (payload && (payload.error || payload.Error)))
        throw new Error(`HTTP ${response.status} ${JSON.stringify(payload ? (payload.error || payload.Error || payload) : '(无响应体)')}`)

    return payload
}

async function tokenhubSubmit(asset)
{
    const payload = await tokenhubRequest('/v1/api/3d/submit', buildTokenHubParams(asset))
    return payload.id
}

async function tokenhubQuery(asset, jobId)
{
    const payload = await tokenhubRequest('/v1/api/3d/query', { model: tokenhubModel(asset), id: jobId })

    // 归一化为 WAIT/RUN/FAIL/DONE（与云 API 通道一致）
    if(payload.status === 'completed')
    {
        const files = (payload.data || []).map(item => ({ Type: item.type, Url: item.url, PreviewImageUrl: item.preview_image_url }))
        return { Status: 'DONE', ResultFile3Ds: files }
    }

    if(payload.status === 'failed' || payload.status === 'error')
        return { Status: 'FAIL', ErrorMessage: JSON.stringify(payload) }

    return { Status: 'RUN' }
}

async function download(url, destination)
{
    const response = await fetch(url)
    if(!response.ok)
        throw new Error(`HTTP ${response.status}`)

    const buffer = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(destination, buffer)
    return buffer.length
}

function isReady(asset)
{
    const record = state.assets[asset.key]
    if(!record || !record.downloadedAt || !fs.existsSync(rawPath(asset.key)))
        return false

    // 真实生成模式下，mock 产物不算完成（避免误把替身当成品而静默跳过提交）
    if(!options.mock && record.engine === 'mock')
        return false

    return true
}

function needsProcessing(asset)
{
    return options.force || !isReady(asset)
}

async function pool(items, limit, worker)
{
    const queue = [ ...items ]
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () =>
    {
        while(queue.length)
        {
            const item = queue.shift()
            await worker(item)
        }
    })
    await Promise.all(runners)
}

function printSummary(assets)
{
    console.log('\n状态汇总:')
    for(const asset of assets)
    {
        const record = state.assets[asset.key] || {}
        const failed = record.status === 'FAIL' || record.status === 'SUBMIT_FAILED'
        const status = isReady(asset) ? '✔ ready' : (failed ? `✘ ${record.status} (${record.error || ''})` : (record.status || '未提交'))
        console.log(`  ${asset.key.padEnd(18)} ${asset.name.padEnd(10)} ${status}`)
    }
}

async function main()
{
    const assets = getAssets()

    if(options.list)
    {
        printSummary(assets)
        return
    }

    const pending = assets.filter(needsProcessing)

    if(!pending.length)
    {
        console.log('所有资产均已生成（--force 可强制重新生成）')
        printSummary(assets)
        return
    }

    fs.mkdirSync(rawDirectory, { recursive: true })
    console.log(`待处理 ${pending.length} 个资产: ${pending.map(asset => asset.key).join(', ')}\n`)

    // Mock 模式：本地文件冒充生成结果
    if(options.mock)
    {
        if(!fs.existsSync(mockSource))
        {
            console.error(`✘ mock 源文件不存在: ${mockSource}`)
            process.exit(1)
        }

        for(const asset of pending)
        {
            fs.copyFileSync(mockSource, rawPath(asset.key))
            state.assets[asset.key] = { ...state.assets[asset.key], engine: 'mock', status: 'MOCK', submittedAt: Date.now(), downloadedAt: Date.now(), error: null }
            console.log(`✔ [mock] ${asset.key} → ${path.relative(projectRoot, rawPath(asset.key))}`)
        }
        saveState()
        printSummary(assets)
        return
    }

    // 真实生成
    const transport = createTransport()

    const toSubmit = pending.filter(asset =>
    {
        const record = state.assets[asset.key]
        const expired = record && record.submittedAt && (Date.now() - record.submittedAt > JOB_EXPIRY)
        return options.force || !record || !record.jobId || record.status === 'FAIL' || expired
    })

    if(toSubmit.length)
        console.log(`提交 ${toSubmit.length} 个生成任务（并发 ${MAX_CONCURRENT}）...`)

    await pool(toSubmit, MAX_CONCURRENT, async asset =>
    {
        try
        {
            const jobId = await transport.submit(asset)
            state.assets[asset.key] = { jobId, status: 'WAIT', submittedAt: Date.now(), downloadedAt: null, engine: getAction(asset), error: null }
            saveState()
            console.log(`⏫ 已提交 ${asset.key} (${asset.name}) JobId=${jobId}`)
        }
        catch(error)
        {
            const message = error.message || JSON.stringify(error)
            state.assets[asset.key] = { ...state.assets[asset.key], jobId: null, status: 'SUBMIT_FAILED', error: message }
            saveState()
            console.error(`✘ 提交失败 ${asset.key}: ${message}`)
        }
    })

    // 轮询直至完成 / 失败 / 超时
    const startedAt = Date.now()
    while(true)
    {
        const actives = pending.filter(asset =>
        {
            const record = state.assets[asset.key]
            return record && record.jobId && !record.downloadedAt && record.status !== 'FAIL' && record.status !== 'SUBMIT_FAILED'
        })

        if(!actives.length)
            break

        if(Date.now() - startedAt > POLL_TIMEOUT)
        {
            console.log('\n轮询超时（任务仍在云端执行）。稍后再次运行本脚本可继续获取结果。')
            break
        }

        for(const asset of actives)
        {
            const record = state.assets[asset.key]
            try
            {
                const response = await transport.query(asset, record.jobId)
                record.status = response.Status
                record.error = response.Status === 'FAIL' ? `${response.ErrorCode || ''} ${response.ErrorMessage || ''}`.trim() : null

                if(response.Status === 'DONE')
                {
                    const file = (response.ResultFile3Ds || []).find(file => (file.Type || '').toLowerCase() === 'glb')
                    if(!file)
                    {
                        record.status = 'FAIL'
                        record.error = '结果中未包含 GLB 文件'
                        console.error(`✘ ${asset.key}: 结果中未包含 GLB 文件`)
                    }
                    else
                    {
                        const size = await download(file.Url, rawPath(asset.key))
                        record.downloadedAt = Date.now()
                        console.log(`✔ 已下载 ${asset.key} (${(size / 1024 / 1024).toFixed(1)} MB)`)

                        if(file.PreviewImageUrl)
                        {
                            try { await download(file.PreviewImageUrl, path.join(rawDirectory, `${asset.key}-preview.png`)) }
                            catch(error) { /* 预览图下载失败可忽略 */ }
                        }
                    }
                }
                else if(response.Status === 'FAIL')
                {
                    console.error(`✘ ${asset.key} 生成失败: ${record.error}`)
                }
                else
                {
                    console.log(`… ${asset.key} 状态: ${response.Status}`)
                }
            }
            catch(error)
            {
                console.error(`… ${asset.key} 查询出错（下轮重试）: ${error.message || error}`)
            }
            saveState()
        }

        const stillWaiting = actives.some(asset => [ 'WAIT', 'RUN' ].includes(state.assets[asset.key].status))
        if(stillWaiting)
            await sleep(POLL_INTERVAL)
        else
            break
    }

    saveState()
    printSummary(assets)

    const failed = pending.filter(asset => !isReady(asset))
    if(failed.length)
        process.exitCode = 1
}

main().catch(error =>
{
    console.error('✘ 脚本异常:', error)
    process.exitCode = 1
})
