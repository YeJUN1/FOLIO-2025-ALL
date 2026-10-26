import './threejs-override.js'
import { Account } from './Game/Account.js'
import { Game } from './Game/Game.js'
import consoleLog from './data/consoleLog.js'

if(import.meta.env.VITE_LOG)
    console.log(
        ...consoleLog
    )

// 登录门禁：游戏先建起来，给登录界面当实景（世界在渲染、昼夜在走），
// 但操作权被 Account 扣着，注册 / 登录成功、进度跟服务器合并完才交给玩家。
// 门禁期间进度字段的 localStorage 写入会被丢弃，免得本地旧进度反过来覆盖服务器那一份。
const account = new Account()
account.guardProgressWrites()

const game = new Game()
account.attach(game)

// 开发模式下留一个调试把手：控制台里能看门禁状态（window.account.gated、
// window.account.game.inputs.locked、--account-tint 这一类），不进生产包
if(import.meta.env.DEV)
    window.account = account

await account.ready()

if(import.meta.env.VITE_GAME_PUBLIC)
    window.game = game
