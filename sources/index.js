import './threejs-override.js'
import { Account } from './Game/Account.js'
import { Game } from './Game/Game.js'
import consoleLog from './data/consoleLog.js'

if(import.meta.env.VITE_LOG)
    console.log(
        ...consoleLog
    )

// 登录门禁：先把账号界面立起来，等用户注册 / 登录成功后才 new Game()。
// 这样游戏各模块读到的 localStorage 已经是跟服务器合并好的进度，不用刷新页面。
const account = new Account()
await account.ready()

if(import.meta.env.VITE_GAME_PUBLIC)
    window.game = new Game()
else
    new Game()
