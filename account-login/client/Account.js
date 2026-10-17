/**
 * 账号
 *
 * 用户名 + 密码的注册 / 登录。用户资料和游戏进度都存在服务器上，
 * 换一台设备登录同一个号，进度就跟着走。
 *
 * 为什么不用手机号 + 验证码：发短信要企业资质（营业执照）才能申请签名，
 * 个人开发者走不通。用户名 + 密码不花钱、不用审核，功能上完全够用。
 * 代价是：没有手机号或邮箱，所以什么都找不回密码——注册时写下来、记牢。
 *
 * 这个模块必须在 Game 之前就绪：index.js 会等 ready() 成功了才 new Game()，
 * 这样游戏各模块读到的 localStorage 已经是合并好的进度，不用再刷新一次页面。
 *
 * 登录态不落盘：token 只存在内存里，每次进入（刷新 / 重新打开）都要重新输密码。
 * 进度仍然在服务器上按账号存，换设备登录同一个号照样接着玩。
 */

const TOKEN_KEY = 'accountToken'
const USER_KEY = 'accountUser'

// 跟服务器同一套规矩：允许中文、字母、数字、下划线、横线，长度 2~16
const USERNAME_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,16}$/
const PASSWORD_MIN = 6

// 跟着账号走的进度：就是现在存在 localStorage 里的这些键
const PROGRESS_KEYS = [
    'achievements',
    'achievementsReward',
    'achievementsTimeStart',
    'achievementsTimeEnd',
    'characterLook',
    'distanceDriven',
    'timePlayed'
]

const SYNC_INTERVAL = 30 * 1000   // 玩的时候每 30 秒把进度回传一次

const ERROR_TEXT = {
    username: 'Username must be 2 to 16 characters, using letters, numbers, Chinese, _ or -',
    password: `Password must be at least ${PASSWORD_MIN} characters`,
    match: 'The two passwords do not match',
    sameAsUsername: 'The password cannot be the same as the username',
    weakPassword: 'That password is too easy to guess, please pick another one',
    passwordTaken: 'Someone is already using that password, please pick another one',
    registered: 'This username is already taken',
    notRegistered: 'No account with this username was found',
    wrongPassword: 'Wrong password',
    locked: 'Too many failed attempts, please try again in 15 minutes',
    ip: 'Too many attempts from here, try again later',
    server: 'Account service is unavailable right now',
    network: 'Cannot reach the server, check your connection'
}

export class Account
{
    static getInstance()
    {
        return Account.instance
    }

    constructor()
    {
        if(Account.instance)
            return Account.instance

        Account.instance = this

        // 登录态只放在内存里：每次进入（刷新页面 / 重新打开）都必须重新输密码。
        // 顺手把以前版本存下来的凭据擦掉，免得它一直躺在浏览器里
        this.token = ''
        this.user = null

        try
        {
            localStorage.removeItem(TOKEN_KEY)
            localStorage.removeItem(USER_KEY)
        }
        catch
        {
            // 擦不掉也不影响
        }

        this.element = document.querySelector('.js-account')
        this.mode = 'login'
        this.busy = false
        this.syncTimer = null
        this.lastUploaded = null
        this.onReady = null

        this.setupUi()
    }

    // ———— 登录界面 ————

    setupUi()
    {
        if(!this.element)
            return

        const element = this.element

        this.ui = {
            status: element.querySelector('.js-account-status'),
            tabs: [ ...element.querySelectorAll('.js-account-tab') ],
            form: element.querySelector('.js-account-form'),
            username: element.querySelector('.js-account-username'),
            password: element.querySelector('.js-account-password'),
            confirmField: element.querySelector('.js-account-confirm-field'),
            confirm: element.querySelector('.js-account-confirm'),
            error: element.querySelector('.js-account-error'),
            submit: element.querySelector('.js-account-submit')
        }

        if(!this.ui.form)
            return

        for(const tab of this.ui.tabs)
            tab.addEventListener('click', () => this.setMode(tab.dataset.mode))

        this.ui.form.addEventListener('submit', (event) =>
        {
            event.preventDefault()
            this.submit()
        })

        this.setMode('login')
    }

    show()
    {
        this.element?.classList.add('is-visible')
    }

    hide()
    {
        this.element?.classList.remove('is-visible')
    }

    setMode(mode)
    {
        this.mode = mode === 'register' ? 'register' : 'login'

        for(const tab of this.ui.tabs)
            tab.classList.toggle('is-active', tab.dataset.mode === this.mode)

        this.ui.confirmField.classList.toggle('is-hidden', this.mode !== 'register')
        this.ui.submit.textContent = this.mode === 'register' ? 'Create account' : 'Log in'

        // 注册这一栏必须把话说清楚：没有手机号邮箱，忘了就是真忘了
        this.setStatus(this.mode === 'register'
            ? 'Pick a username, then a password of 6 or more characters that is hard to guess. Write it down — there is no way to recover it.'
            : 'Sign in to play online and keep your progress on every device.')

        this.setError(null)
    }

    setError(text)
    {
        if(!this.ui)
            return

        this.ui.error.textContent = text || ''
        this.ui.error.classList.toggle('is-hidden', !text)
    }

    setStatus(text)
    {
        if(!this.ui || !this.ui.status)
            return

        this.ui.status.textContent = text || ''
        this.ui.status.classList.toggle('is-hidden', !text)
    }

    setBusy(busy)
    {
        this.busy = busy

        if(this.ui)
            this.ui.submit.disabled = busy
    }

    // ———— 对外 ————

    getToken()
    {
        return this.token
    }

    getNickname()
    {
        return this.user ? this.user.nickname : ''
    }

    /**
     * 等用户登录好。index.js 拿到这个 Promise 的 resolve 才会去 new Game()。
     * 每次进来都要求登录，所以这里只管把登录界面亮出来。
     */
    ready()
    {
        return new Promise((resolve) =>
        {
            this.onReady = resolve

            this.show()
        })
    }

    finish()
    {
        this.setStatus('')
        this.hide()
        this.startAutoSync()

        const resolve = this.onReady
        this.onReady = null

        if(resolve)
            resolve()
    }

    logout()
    {
        this.clearToken()
        window.location.reload()
    }

    // 服务器（通过联机通道）说不认我们手上的 token：先跟 HTTP 那边再核对一次。
    // 联机通道说不认，可能只是它一时抽风（比如数据库正忙），这时候把 token 删了
    // 就等于凭空把人踢下线；只有 HTTP 也明确回 401 才是真的失效。
    async handleAuthFailed()
    {
        if(!this.token)
            return

        const result = await this.request('/api/me')

        if(result.ok)
            return

        if(result.error === 'auth')
        {
            this.clearToken()
            window.location.reload()
        }

        // 网络不通 / 服务器 5xx：留着 token，等服务器恢复了自己会再连上
    }

    // ———— 提交 ————

    async submit()
    {
        if(this.busy)
            return

        const username = this.ui.username.value.trim()
        const password = this.ui.password.value

        this.setError(null)

        if(!USERNAME_PATTERN.test(username))
        {
            this.setError(ERROR_TEXT.username)
            return
        }

        if(password.length < PASSWORD_MIN)
        {
            this.setError(ERROR_TEXT.password)
            return
        }

        // 这条前端先拦一道，省得白跑一趟服务器。
        // 只在注册时管：老账号的密码是无所谓跟用户名一样的，登录不能被它挡住。
        if(this.mode === 'register' && password.toLowerCase() === username.toLowerCase())
        {
            this.setError(ERROR_TEXT.sameAsUsername)
            return
        }

        // 没有找回密码的途径，所以注册时输两遍，防止手滑打错
        if(this.mode === 'register' && password !== this.ui.confirm.value)
        {
            this.setError(ERROR_TEXT.match)
            return
        }

        const path = this.mode === 'register' ? '/api/register' : '/api/login'

        this.setBusy(true)
        const result = await this.request(path, { body: { username, password } })
        this.setBusy(false)

        if(!result.ok)
        {
            this.setError(ERROR_TEXT[result.error] || ERROR_TEXT.server)

            // 这个名字还没人注册，顺手把人引到"注册"那一栏
            if(result.error === 'notRegistered' && this.mode === 'login')
            {
                this.setMode('register')
                this.setError(ERROR_TEXT.notRegistered)
            }

            return
        }

        this.token = result.data.token
        this.setUser(result.data.user)

        // 本地可能还攒着没上传的进度（比如这台设备以前玩过），合并后再存回去
        const merged = this.mergeProgress(this.collectLocalProgress(), result.data.progress)
        this.applyProgress(merged)
        this.syncProgress(true)

        this.finish()
    }

    // ———— 进度同步 ————

    collectLocalProgress()
    {
        const progress = {}

        for(const key of PROGRESS_KEYS)
        {
            const raw = localStorage.getItem(key)

            if(raw === null)
                continue

            try
            {
                progress[key] = JSON.parse(raw)
            }
            catch
            {
                // 不是 JSON（比如车漆名 'red'）就当普通字符串
                progress[key] = raw
            }
        }

        return progress
    }

    /**
     * 本地进度和服务器进度合一份。
     *
     * 规则：能比的取"更多的那个"（成就取并集/取大、里程和时间取大），
     * 纯选择类的（车漆、人物形象）以服务器为准——服务器才是跨设备的那一份。
     */
    mergeProgress(local, remote)
    {
        if(!remote)
            return local || {}

        if(!local)
            return remote

        const merged = { ...local, ...remote }

        if(local.achievements && remote.achievements)
        {
            const achievements = {}
            const names = new Set([ ...Object.keys(local.achievements), ...Object.keys(remote.achievements) ])

            for(const name of names)
            {
                const left = local.achievements[name]
                const right = remote.achievements[name]

                if(Array.isArray(left) || Array.isArray(right))
                {
                    // 集合型的成就（比如"去过哪些房间"）：并集
                    achievements[name] = [ ...new Set([
                        ...(Array.isArray(left) ? left : []),
                        ...(Array.isArray(right) ? right : [])
                    ]) ]
                }
                else
                {
                    // 计数型的成就：取大的
                    achievements[name] = Math.max(Number(left) || 0, Number(right) || 0)
                }
            }

            merged.achievements = achievements
        }

        for(const key of [ 'achievementsTimeEnd', 'distanceDriven', 'timePlayed' ])
        {
            const left = Number(local[key]) || 0
            const right = Number(remote[key]) || 0

            if(left || right)
                merged[key] = Math.max(left, right)
        }

        // "开始计时"那个时间取早的，算出来的总时长才不会被截短
        const startLeft = Number(local.achievementsTimeStart) || 0
        const startRight = Number(remote.achievementsTimeStart) || 0

        if(startLeft && startRight)
            merged.achievementsTimeStart = Math.min(startLeft, startRight)
        else
            merged.achievementsTimeStart = startLeft || startRight

        if(!startLeft && !startRight)
            delete merged.achievementsTimeStart

        // 车漆和人物形象是选择，取服务器的
        if(remote.achievementsReward)
            merged.achievementsReward = remote.achievementsReward

        if(remote.characterLook)
            merged.characterLook = remote.characterLook

        return merged
    }

    applyProgress(progress)
    {
        if(!progress)
            return

        for(const key of PROGRESS_KEYS)
        {
            if(!(key in progress))
                continue

            const value = progress[key]

            if(value === undefined || value === null || value === '')
            {
                localStorage.removeItem(key)
                continue
            }

            localStorage.setItem(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
        }
    }

    // 玩的时候定时把进度回传，关页面时再抢着传一次，免得白玩
    startAutoSync()
    {
        if(this.syncTimer)
            return

        this.syncTimer = setInterval(() => this.syncProgress(), SYNC_INTERVAL)

        const flush = () => this.syncProgress()

        window.addEventListener('pagehide', flush)
        document.addEventListener('visibilitychange', () =>
        {
            if(document.visibilityState === 'hidden')
                flush()
        })
    }

    syncProgress(force = false)
    {
        if(!this.token)
            return

        const progress = this.collectLocalProgress()
        const signature = JSON.stringify(progress)

        if(!force && signature === this.lastUploaded)
            return

        this.lastUploaded = signature

        // keepalive：关页面时这一发也能发出去
        fetch('/api/progress', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify({ progress }),
            keepalive: true
        }).catch(() =>
        {
            // 传不上去就算了，下次再传
            this.lastUploaded = null
        })
    }

    // ———— 小工具 ————

    setUser(user)
    {
        this.user = user || null
    }

    clearToken()
    {
        this.token = ''
        this.user = null
        this.lastUploaded = null

        try
        {
            localStorage.removeItem(TOKEN_KEY)
            localStorage.removeItem(USER_KEY)
        }
        catch
        {
            // 清不掉也不影响
        }
    }

    async request(path, options = {})
    {
        const headers = {}

        if(options.body)
            headers['Content-Type'] = 'application/json'

        if(this.token)
            headers['Authorization'] = `Bearer ${this.token}`

        let response

        try
        {
            response = await fetch(path, {
                method: options.body ? 'POST' : 'GET',
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined
            })
        }
        catch
        {
            return { ok: false, error: 'network', data: null }
        }

        let data = null

        try
        {
            data = await response.json()
        }
        catch
        {
            data = null
        }

        if(!response.ok)
            return { ok: false, error: (data && data.error) || 'server', data }

        return { ok: true, error: null, data: data || {} }
    }
}