// 一键把「账号服务 + 游戏」都拉起来（npm start）
//
// 登录 / 注册要真能用，就必须有 account-login/server 那个服务在跑（它把账号和进度
// 存在同目录的 data.db 里，纯 Node 内置模块，不用 npm install）。以前得开两个终端，
// 这里合成一个：先起服务，再起 vite；服务起不来只报警告，不拖累游戏本体。
//
//   npm start        账号服务(3000) + 游戏(5173)
//   npm run dev      只起游戏（跟以前一样，登录界面会连不上接口）
//   npm run account  只起账号服务

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const account = spawn(process.execPath, [ path.join(root, 'account-login', 'server', 'account-server.js') ], {
    cwd: path.join(root, 'account-login', 'server'),
    stdio: 'inherit',
    env: process.env,
})

let accountAlive = false

account.on('exit', (code) =>
{
    // 端口被占用 / 已经有一个在服务上：不算致命，游戏照跑，接口走已有的那一个
    if(!accountAlive)
        console.warn(`⚠️  账号服务没能启动（退出码 ${code}）。若已有服务在 3000 端口上可忽略；否则登录会失败。`)
})

// 半秒内没退出就认为起来了（端口冲突会在第一时间失败）
setTimeout(() =>
{
    accountAlive = account.exitCode === null
}, 500)

const vite = spawn('npx', [ 'vite', '--host', '--mode', 'development' ], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
})

const forward = (signal) => process.on(signal, () =>
{
    account.kill(signal)
    vite.kill(signal)
})

forward('SIGINT')
forward('SIGTERM')

vite.on('exit', (code) =>
{
    account.kill()
    process.exit(code ?? 0)
})
