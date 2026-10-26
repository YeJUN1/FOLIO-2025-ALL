// ———— 账户系统（注册 / 登录 / 会话 / 进度存档）独立版 ————
//
// 这份代码是从 driver 项目的 server/index.js 里拆出来的「账号部分」，
// 联机、座位、船只、语音这些跟登录无关的内容都去掉了，只留账户闭环。
//
// 私密信息已剔除，本文件不含：
//   - 服务器地址 / 公网 IP / 部署端口
//   - 任何账号的用户名、密码、密码哈希
//   - 密码指纹密钥：运行时自动生成到同目录的 password-pepper.txt（不进代码、不进 git）
//   - 账号数据库：运行时自动创建 data.db（不在拷贝范围内）
//
// 跑起来（不需要 npm install，用的全是 Node 内置模块）：
//   node account-server.js                 默认 3000 端口
//   PORT=4000 node account-server.js
// 需要 Node 22.5+（用到内置的 node:sqlite）。
//
// 接口一览（前端对应 Account.js）：
//   POST /api/register  { username, password }            -> { ok, token, user, progress }
//   POST /api/login     { username, password }            -> { ok, token, user, progress }
//   GET  /api/me         Header: Authorization: Bearer t  -> { ok, user, progress }
//   GET  /api/ping                                       -> { ok, service }（登录界面的状态灯用）
//   POST /api/progress   Header: Bearer + { progress }    -> { ok }
// 错误码用名字回给前端（不暴露细节）：username / password / weakPassword / sameAsUsername /
//   registered / passwordTaken / notRegistered / wrongPassword / locked / ip / auth / server

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000

// 用户名 + 密码的注册 / 登录，用户资料和游戏进度都存在 SQLite 里。
// 用的是 Node 自带的 node:sqlite，不用装任何依赖。
//
// 为什么不是手机号+验证码：发短信要企业资质（营业执照）才能申请签名，
// 个人开发者走不通。用户名+密码不花钱、不用审核，功能上完全够用。
// 代价是：没有手机号或邮箱，所以什么都找不回密码，注册时务必记牢。
//
// 密码不存明文，存的是 scrypt 派生出来的哈希 + 每个账号独立的随机盐。
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000   // 登录状态保持 30 天
const MAX_PROGRESS_BYTES = 64 * 1024           // 进度存档大小上限
const MAX_BODY_BYTES = 128 * 1024              // 请求体上限

const USERNAME_MIN = 2                         // 用户名长度
const USERNAME_MAX = 16
const PASSWORD_MIN = 6                         // 密码长度
const PASSWORD_MAX = 128

// 同一个 IP 每小时最多注册几次（包括填错了重试的，只算"格式填对了"的那种）。
// 一是挡批量注册，二是挡"拿注册接口反复试探某个密码有没有人用过"。
// 定得松一点：公司或学校共用出口 IP，同一条网线上可能有好几个人在注册。
const REGISTER_IP_HOURLY_LIMIT = 30
// 同一个用户名连续输错几次密码就暂时锁住（挡在线爆破）
const LOGIN_MAX_FAILS = 10
const LOGIN_FAIL_WINDOW = 15 * 60 * 1000

// 存档放在同目录的 data.db，跟代码分开，删代码不会顺手删掉账号。
const DB_FILE = path.join(currentDirectory, 'data.db')

function addMissingColumns()
{
    const columns = db.prepare("SELECT name FROM pragma_table_info('users')").all()

    if(!columns.some((column) => column.name === 'password_print'))
    {
        db.exec('ALTER TABLE users ADD COLUMN password_print TEXT')
        console.log('🔧 users 表补上 password_print 字段')
    }
}

let db = null

try
{
    db = new DatabaseSync(DB_FILE)

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            username       TEXT PRIMARY KEY,
            display        TEXT NOT NULL,
            password_hash  TEXT NOT NULL,
            salt           TEXT NOT NULL,
            password_print TEXT,
            created_at     INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            username   TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS progress (
            username   TEXT PRIMARY KEY,
            data       TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS sessions_username ON sessions (username);
    `)

    addMissingColumns()

    // 一个密码只能被一个账号用。交给数据库来保证，两个人同时抢也能拦住。
    // 用 WHERE 排除空值，老账号没这列的值时不会互相冲突。
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_password_print
            ON users (password_print) WHERE password_print IS NOT NULL;
    `)

    console.log(`🗂  账号数据库已就绪：${DB_FILE}`)
}
catch(error)
{
    db = null
    console.error('❌ 账号数据库打不开，注册 / 登录会不可用：', error.message)
}

// 会话 token 只存哈希：万一数据库被看到，也拿不到能直接用的 token
function hashToken(token)
{
    return crypto.createHash('sha256').update(token).digest('hex')
}

function sendJson(response, status, data)
{
    const body = JSON.stringify(data)

    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    })
    response.end(body)
}

// 收请求体，超长就直接放弃（免得有人拿超大 body 打内存）
function readJsonBody(request)
{
    return new Promise((resolve) =>
    {
        let size = 0
        const chunks = []
        let done = false

        const finish = (value) =>
        {
            if(done)
                return

            done = true
            resolve(value)
        }

        request.on('data', (chunk) =>
        {
            size += chunk.length

            if(size > MAX_BODY_BYTES)
            {
                finish(null)
                request.destroy()
                return
            }

            chunks.push(chunk)
        })

        request.on('end', () =>
        {
            try
            {
                finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
            }
            catch
            {
                finish(null)
            }
        })

        request.on('error', () => finish(null))
    })
}

// 用户名：只留看得见的字符（空格、换行全部丢掉），长度 2~16，
// 允许中文、字母、数字、下划线、横线。返回的是"原样大小写"的那份，显示用。
function cleanUsername(value)
{
    const username = String(value || '').replace(/\s+/g, '')

    if(username.length < USERNAME_MIN || username.length > USERNAME_MAX)
        return null

    return /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(username) ? username : null
}

// 数据库里查重、登录时用的是小写归一化后的那份，这样 Alice 和 alice 算同一个号，
// 免得出现两个"看起来一样"的名字骗人。
function usernameKey(username)
{
    return username.toLowerCase()
}

function cleanPassword(value)
{
    const password = String(value || '')

    if(password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
        return null

    return password
}

// ———— 密码哈希 ————
// scrypt 故意算得慢，别人偷到数据库也很难一个个试出原密码。
// 用异步版本，免得算哈希的时候把整个服务器卡住。
const SCRYPT_KEYLEN = 64

function hashPassword(password, salt)
{
    return new Promise((resolve, reject) =>
    {
        crypto.scrypt(password, salt, SCRYPT_KEYLEN, (error, key) =>
        {
            if(error)
                reject(error)
            else
                resolve(key.toString('hex'))
        })
    })
}

// 定长比较，别让响应时间泄露"猜对了几位"
function sameHash(left, right)
{
    const a = Buffer.from(String(left), 'hex')
    const b = Buffer.from(String(right), 'hex')

    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

// ———— 密码指纹（用来查"这个密码是不是已经有人用了"）————
//
// 要做这个检查，就必须能用同一套算法把两个密码比出来，于是无法再加随机盐。
// 没有盐的哈希等于给了别人一张对照表：数据库一旦泄露，弱密码会被立刻反查出来。
// 所以这里掺一把只存在服务器上的密钥（pepper）：光拿到数据库算不出任何东西，
// 必须连这把密钥一起偷走才行。密钥单独存文件，不进代码、不进 git。
const PEPPER_FILE = path.join(currentDirectory, 'password-pepper.txt')

function loadPepper()
{
    try
    {
        const existing = fs.readFileSync(PEPPER_FILE, 'utf8').trim()

        if(existing.length >= 32)
            return existing
    }
    catch
    {
        // 第一次跑，文件还不存在
    }

    const created = crypto.randomBytes(32).toString('hex')

    try
    {
        fs.writeFileSync(PEPPER_FILE, created, { mode: 0o600 })
        console.log(`🔑 已生成密码指纹密钥：${PEPPER_FILE}（别删，删了老密码的指纹就对不上了）`)
    }
    catch(error)
    {
        console.error('❌ 密码指纹密钥存不下来，重启后会变：', error.message)
    }

    return created
}

const pepper = loadPepper()

function passwordPrint(password)
{
    return crypto.createHmac('sha256', pepper).update(password).digest('hex')
}

// ———— 太简单的密码不让用 ————
//
// 这条比"不同人不能用同一个密码"更管用：绝大多数账号被盗，都是因为密码本身好猜。
const WEAK_PASSWORDS = new Set([
    '123456', '1234567', '12345678', '123456789', '1234567890',
    '111111', '1111111', '11111111', '000000', '666666', '777777', '555555',
    '123123', '123321', '112233', '121212', '131313', '159753', '654321', '789456', '987654321',
    'password', 'password1', 'passw0rd', 'p@ssword', 'p@ssw0rd',
    'qwerty', 'qwertyui', 'qwerty123', 'qwertyuiop', '1qaz2wsx', '1qazxsw2', '1q2w3e4r', 'qazwsx', 'qwe123',
    'zxcvbnm', 'asdfgh', 'asdfghjkl', 'aqswdefr', 'zaq12wsx', 'abcd1234', 'abc123', 'a123456', '123456a', 'aa123456',
    'iloveyou', 'woaini', 'woaini1314', '5201314', '5211314',
    'admin', 'admin123', 'root', 'test', 'test123', 'guest', 'letmein', 'welcome',
    'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
    'superman', 'batman', 'master', 'shadow', 'computer', 'trustno1', 'whatever', 'freedom'
])

// 顺子：123456、abcdef、654321 都算
function isSequential(text)
{
    if(text.length < 4)
        return false

    let ascending = true
    let descending = true

    for(let i = 1; i < text.length; i++)
    {
        const step = text.charCodeAt(i) - text.charCodeAt(i - 1)

        if(step !== 1)
            ascending = false

        if(step !== -1)
            descending = false
    }

    return ascending || descending
}

function isWeakPassword(password)
{
    const lower = password.toLowerCase()

    // 常见弱密码
    if(WEAK_PASSWORDS.has(lower))
        return true

    // 全是同一个字符：aaaaaa、111111
    if(/^(.)\1+$/.test(lower))
        return true

    // 顺子
    if(isSequential(lower))
        return true

    // 只有数字，而且不满 8 位。6 位纯数字几秒钟就能试完
    if(/^\d+$/.test(lower) && lower.length < 8)
        return true

    return false
}

// 注册时统一过一遍密码规矩，返回 null 表示通过，否则是要回给前端的错误名
function checkPasswordRules(username, password)
{
    // 密码跟用户名一样（不分大小写），等于没设密码
    if(password.toLowerCase() === username.toLowerCase())
        return 'sameAsUsername'

    if(isWeakPassword(password))
        return 'weakPassword'

    return null
}

// 同一个 IP 每小时最多注册几次。
// 只统计"用户名和密码都填对了格式"的那种请求——纯粹的填错（名字太短之类）
// 不算，否则用户连试几次就被挡在门外，属于误伤自己人。
const registerIpLog = new Map()

function registerCountFromIp(ip, now)
{
    return (registerIpLog.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000).length
}

function allowRegisterFromIp(ip)
{
    return registerCountFromIp(ip, Date.now()) < REGISTER_IP_HOURLY_LIMIT
}

function recordRegisterFromIp(ip)
{
    const now = Date.now()
    const list = (registerIpLog.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000)

    list.push(now)
    registerIpLog.set(ip, list)
}

// 同一个用户名连续输错密码就暂时锁住，挡在线爆破。存在内存里，重启就清空。
const loginFails = new Map()

function isLoginLocked(key)
{
    const record = loginFails.get(key)

    if(!record)
        return false

    if(Date.now() > record.until)
    {
        loginFails.delete(key)
        return false
    }

    return record.count >= LOGIN_MAX_FAILS
}

function recordLoginFail(key)
{
    const now = Date.now()
    const record = loginFails.get(key)

    if(!record || now > record.until)
        loginFails.set(key, { count: 1, until: now + LOGIN_FAIL_WINDOW })
    else
        record.count++
}

function createSession(username)
{
    const token = crypto.randomBytes(32).toString('hex')

    db.prepare('INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(token), username, Date.now() + SESSION_TTL)

    return token
}

function getAccountByToken(token)
{
    if(!db || typeof token !== 'string' || token.length < 16 || token.length > 256)
        return null

    const hash = hashToken(token)
    const row = db.prepare(`
        SELECT sessions.expires_at AS expiresAt, users.username AS username, users.display AS nickname
        FROM sessions JOIN users ON users.username = sessions.username
        WHERE sessions.token_hash = ?
    `).get(hash)

    if(!row)
        return null

    if(Date.now() > row.expiresAt)
    {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash)
        return null
    }

    return { username: row.username, nickname: row.nickname }
}

function getAccountFromRequest(request)
{
    const header = request.headers['authorization'] || ''
    const match = /^Bearer\s+(.+)$/i.exec(header)

    return match ? getAccountByToken(match[1].trim()) : null
}

function readProgress(username)
{
    const row = db.prepare('SELECT data FROM progress WHERE username = ?').get(username)

    if(!row)
        return null

    try
    {
        return JSON.parse(row.data)
    }
    catch
    {
        return null
    }
}

async function apiRegister(request, response)
{
    if(!db)
        return sendJson(response, 503, { error: 'server' })

    const ip = request.socket.remoteAddress || 'unknown'

    if(!allowRegisterFromIp(ip))
        return sendJson(response, 429, { error: 'ip' })

    const body = await readJsonBody(request)
    const username = cleanUsername(body && body.username)
    const password = cleanPassword(body && body.password)

    if(!username)
        return sendJson(response, 400, { error: 'username' })

    if(!password)
        return sendJson(response, 400, { error: 'password' })

    // 格式都对上了才算一次"真的在注册"，从这里开始才计数
    recordRegisterFromIp(ip)

    // 密码不能和用户名一样、也不能一眼就能猜到
    const weak = checkPasswordRules(username, password)

    if(weak)
        return sendJson(response, 400, { error: weak })

    const key = usernameKey(username)

    if(db.prepare('SELECT username FROM users WHERE username = ?').get(key))
        return sendJson(response, 409, { error: 'registered' })

    const print = passwordPrint(password)

    if(db.prepare('SELECT username FROM users WHERE password_print = ?').get(print))
        return sendJson(response, 409, { error: 'passwordTaken' })

    const salt = crypto.randomBytes(16).toString('hex')
    const passwordHash = await hashPassword(password, salt)

    try
    {
        db.prepare(`
            INSERT INTO users (username, display, password_hash, salt, password_print, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(key, username, passwordHash, salt, print, Date.now())
    }
    catch
    {
        // 两个人同时抢同一个名字或同一个密码，唯一约束会拦下后来的那个
        if(db.prepare('SELECT username FROM users WHERE username = ?').get(key))
            return sendJson(response, 409, { error: 'registered' })

        return sendJson(response, 409, { error: 'passwordTaken' })
    }

    const token = createSession(key)

    console.log(`👤 新账号注册：${username}`)

    sendJson(response, 200, {
        ok: true,
        token,
        user: { username: key, nickname: username },
        progress: null
    })
}

async function apiLogin(request, response)
{
    if(!db)
        return sendJson(response, 503, { error: 'server' })

    const body = await readJsonBody(request)
    const username = cleanUsername(body && body.username)
    const password = String((body && body.password) || '')

    if(!username)
        return sendJson(response, 400, { error: 'username' })

    if(!password)
        return sendJson(response, 400, { error: 'password' })

    const key = usernameKey(username)

    if(isLoginLocked(key))
        return sendJson(response, 429, { error: 'locked' })

    const user = db.prepare('SELECT username, display, password_hash, salt FROM users WHERE username = ?').get(key)

    if(!user)
        return sendJson(response, 404, { error: 'notRegistered' })

    const passwordHash = await hashPassword(password, user.salt)

    if(!sameHash(passwordHash, user.password_hash))
    {
        recordLoginFail(key)
        return sendJson(response, 401, { error: 'wrongPassword' })
    }

    loginFails.delete(key)

    const token = createSession(key)

    console.log(`👤 登录：${user.display}`)

    sendJson(response, 200, {
        ok: true,
        token,
        user: { username: key, nickname: user.display },
        progress: readProgress(key)
    })
}

async function apiMe(request, response)
{
    if(!db)
        return sendJson(response, 503, { error: 'server' })

    const account = getAccountFromRequest(request)

    if(!account)
        return sendJson(response, 401, { error: 'auth' })

    sendJson(response, 200, { ok: true, user: account, progress: readProgress(account.username) })
}

async function apiSaveProgress(request, response)
{
    if(!db)
        return sendJson(response, 503, { error: 'server' })

    const account = getAccountFromRequest(request)

    if(!account)
        return sendJson(response, 401, { error: 'auth' })

    const body = await readJsonBody(request)
    const progress = body && body.progress

    if(!progress || typeof progress !== 'object' || Array.isArray(progress))
        return sendJson(response, 400, { error: 'progress' })

    const text = JSON.stringify(progress)

    if(text.length > MAX_PROGRESS_BYTES)
        return sendJson(response, 413, { error: 'tooLarge' })

    db.prepare(`
        INSERT INTO progress (username, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(account.username, text, Date.now())

    sendJson(response, 200, { ok: true })
}

// 把带异常的 handler 包一层，保证任何一边出错都还能回一句正经的 JSON，而不是让连接吊死
function route(handler)
{
    return (request, response) =>
    {
        Promise.resolve(handler(request, response)).catch((error) =>
        {
            console.error('接口出错：', error)

            try
            {
                sendJson(response, 500, { error: 'server' })
            }
            catch
            {
                // 头都发出去了就算了
            }
        })
    }
}

function handleRequest(request, response)
{
    let pathname = ''

    try
    {
        pathname = new URL(request.url, 'http://localhost').pathname
    }
    catch
    {
        pathname = ''
    }

    if(request.method === 'POST' && pathname === '/api/register')
        return route(apiRegister)(request, response)

    if(request.method === 'POST' && pathname === '/api/login')
        return route(apiLogin)(request, response)

    if(request.method === 'POST' && pathname === '/api/progress')
        return route(apiSaveProgress)(request, response)

    if(request.method === 'GET' && pathname === '/api/me')
        return route(apiMe)(request, response)

    // 健康探针：登录界面那个状态灯靠它确认服务活着（走 200，不至于在控制台里留一串 401）
    if(request.method === 'GET' && pathname === '/api/ping')
        return sendJson(response, 200, { ok: true, service: 'account' })

    return sendJson(response, 404, { error: 'notFound' })
}

// 每小时清一次过期会话和过期的限流记录，别让它们一直占着内存
setInterval(() =>
{
    if(!db)
        return

    try
    {
        const now = Date.now()

        db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)

        for(const [ key, record ] of loginFails)
            if(now > record.until)
                loginFails.delete(key)

        for(const [ ip, list ] of registerIpLog)
        {
            const fresh = list.filter((time) => now - time < 60 * 60 * 1000)

            if(fresh.length)
                registerIpLog.set(ip, fresh)
            else
                registerIpLog.delete(ip)
        }
    }
    catch
    {
        // 清理失败不影响正常使用，下次再清
    }
}, 60 * 60 * 1000)

// 有证书就上 HTTPS（同目录 certs/key.pem + certs/cert.pem），没有就退回 HTTP。
// 账户接口本身不挑协议，但前端要用麦克风 / 某些浏览器能力就得是 HTTPS 或 localhost。
const KEY_FILE = path.join(currentDirectory, 'certs', 'key.pem')
const CERT_FILE = path.join(currentDirectory, 'certs', 'cert.pem')

let server

if(fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE))
{
    server = https.createServer({
        key: fs.readFileSync(KEY_FILE),
        cert: fs.readFileSync(CERT_FILE)
    }, handleRequest)

    console.log('🔒 已启用 HTTPS（自签证书）')
}
else
{
    server = http.createServer(handleRequest)

    console.log('⚠️  没找到 certs/ 证书，退回 HTTP')
}

server.listen(PORT, () =>
{
    console.log(`🚀 账户服务已启动：http://localhost:${PORT}（接口都在 /api/ 下）`)
})
