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
 *
 * 门禁的做法（见 index.js）：Game 先建起来，世界在登录界面背面照常渲染、昼夜照常走，
 * 但操作权（inputs.locked）和进度写入（guardProgressWrites）都被这里扣着，
 * 登录成功、服务器那一份合并完才放开。
 */

import * as THREE from 'three/webgpu'

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
const PROBE_INTERVAL = 4 * 1000   // 服务没在跑时，隔多久再试一次
const AMBIENT_INTERVAL = 300      // 幕布色调多久跟随一次天色
const LEAVE_DURATION = 420        // 登录成功后淡出的时长（跟 account.styl 对上）

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
    server: 'The account service did not answer — retrying automatically, no need to refresh',
    network: 'Cannot reach the account service yet — it is retried every few seconds'
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

        // 门禁相关：游戏已经在底下跑了，但操作权、进度写入、开场提示都先握在我们手里
        this.game = null
        this.gated = true
        this.serviceOnline = null
        this.probeTimer = null
        this.ambientTimer = null
        this.restoreWrites = null
        this.droppedWrites = new Set()
        this.introWasVisible = { label: false }
        this.nametag = null
        this.vector = new THREE.Vector3()
        this.worldShell = document.querySelector('.game')

        document.body.classList.add('is-account-gated')

        // 门禁期间让背后的游戏 UI 整体退出焦点序列与鼠标（不然 Tab 能到菜单/地图按钮上）
        if(this.worldShell)
            this.worldShell.inert = true

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
            tabsWrap: element.querySelector('.js-account-tabs'),
            form: element.querySelector('.js-account-form'),
            username: element.querySelector('.js-account-username'),
            password: element.querySelector('.js-account-password'),
            reveal: element.querySelector('.js-account-reveal'),
            confirmField: element.querySelector('.js-account-confirm-field'),
            confirm: element.querySelector('.js-account-confirm'),
            error: element.querySelector('.js-account-error'),
            errorText: element.querySelector('.js-account-error-text'),
            submit: element.querySelector('.js-account-submit'),
            submitLabel: element.querySelector('.js-account-submit-label'),
            connection: element.querySelector('.js-account-connection'),
            connectionText: element.querySelector('.js-account-connection-text'),
            logout: document.querySelector('.js-account-logout'),
            name: document.querySelector('.js-account-name'),
            nametags: document.querySelector('.js-nametags')
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

        // 密码显隐小眼睛
        this.ui.reveal?.addEventListener('click', () => this.toggleReveal())

        // 手一动手就把上一条报错收掉，别让它一直挂在脸上
        for(const field of [ this.ui.username, this.ui.password, this.ui.confirm ])
            field?.addEventListener('input', () => this.setError(null))

        // 菜单里那行「Account」：登出 + 显示当前昵称
        this.ui.logout?.addEventListener('click', () => this.logout())

        this.setMode('login')

        // 焦点直接给用户名，键盘党不用去够鼠标
        this.ui.username?.focus({ preventScroll: true })
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
        {
            const active = tab.dataset.mode === this.mode
            tab.classList.toggle('is-active', active)
            tab.setAttribute('aria-selected', active ? 'true' : 'false')
        }

        // 6：底下那条光框靠一个 CSS 变量滑过去，不是瞬间跳
        this.ui.tabsWrap?.style.setProperty('--account-tab', this.mode === 'register' ? '1' : '0')

        this.ui.confirmField.classList.toggle('is-hidden', this.mode !== 'register')

        // 藏起来那一行不该还能 Tab 到
        if(this.ui.confirm)
            this.ui.confirm.disabled = this.mode !== 'register'

        this.setSubmitLabel(this.mode === 'register' ? 'Create account' : 'Log in')

        // 注册这一栏必须把话说清楚：没有手机号邮箱，忘了就是真忘了
        this.setStatus(this.mode === 'register'
            ? 'Pick a username, then a password of 6 or more characters that is hard to guess. Write it down — there is no way to recover it.'
            : 'Sign in to play online and keep your progress on every device.')

        this.setError(null)
    }

    setSubmitLabel(text)
    {
        if(this.ui?.submitLabel)
            this.ui.submitLabel.textContent = text
        else if(this.ui?.submit)
            this.ui.submit.textContent = text
    }

    /**
     * 报错。传了 field 就把那个输入框标红（aria-invalid），不传只改文案。
     */
    setError(text, field = null)
    {
        if(!this.ui)
            return

        const target = this.ui.errorText || this.ui.error
        target.textContent = text || ''
        this.ui.error.classList.toggle('is-hidden', !text)

        // 7：报错要抖一下。同一段动画得靠一次 reflow 才能重播
        this.ui.error.classList.remove('is-shown')

        if(text)
        {
            void this.ui.error.offsetWidth
            this.ui.error.classList.add('is-shown')
        }

        for(const input of [ this.ui.username, this.ui.password, this.ui.confirm ])
            input?.setAttribute('aria-invalid', text && input === field ? 'true' : 'false')
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

        if(!this.ui)
            return

        this.ui.submit.disabled = busy
        this.ui.submit.classList.toggle('is-busy', busy)
        this.ui.submit.setAttribute('aria-busy', busy ? 'true' : 'false')

        // 8：转圈的时候换个说法（宽度被 min-width 锁住，不会一抽一抽）
        this.setSubmitLabel(busy
            ? (this.mode === 'register' ? 'Creating account…' : 'Signing in…')
            : (this.mode === 'register' ? 'Create account' : 'Log in'))
    }

    toggleReveal()
    {
        const input = this.ui?.password
        const button = this.ui?.reveal

        if(!input || !button)
            return

        const shown = input.type === 'password'
        input.type = shown ? 'text' : 'password'
        button.setAttribute('aria-pressed', shown ? 'true' : 'false')
        button.setAttribute('aria-label', shown ? 'Hide password' : 'Show password')
        button.title = shown ? 'Hide password' : 'Show password'

        // 切完光标回到末尾，不然一切换光标就跑到开头
        const caret = input.value.length
        input.focus()
        input.setSelectionRange(caret, caret)
    }

    // ———— 门禁：游戏在底下跑，操作权和进度写入先握着 ————

    /**
     * 挡住门禁期间对进度字段的 localStorage 写入。
     * Game 一建起来就会写 achievementsTimeStart 之类的键，那时服务器上那一份还没
     * 合并进来，让它写下去等于拿本地旧进度去覆盖服务器（换设备时会丢进度）。
     */
    guardProgressWrites()
    {
        const storage = window.localStorage
        const original = storage.setItem.bind(storage)

        storage.setItem = (key, value) =>
        {
            if(this.gated && PROGRESS_KEYS.includes(key))
            {
                this.droppedWrites.add(key)
                return
            }

            return original(key, value)
        }

        this.restoreWrites = () =>
        {
            delete storage.setItem
            this.gated = false
        }
    }

    // 合并之前先把闸门拆掉，不然 applyProgress 自己也被挡着写不进去
    releaseWrites()
    {
        this.restoreWrites?.()
        this.restoreWrites = null
    }

    /**
     * 把游戏接成登录界面的背景：世界照常渲染、昼夜照常走，但玩家拿不到操作权。
     * index.js 里 new Game() 之后立刻调这里。
     */
    attach(game)
    {
        this.game = game

        if(game.inputs)
            game.inputs.locked = true

        // 开场的加载环 / 文字是分批建出来的，可能比 attach 晚到，
        // 所以不在这儿藏，交给每三百毫秒一跳的 syncAmbient 顺手藏
        // 12：幕布颜色跟随当下天色
        this.startAmbient()

        // 服务状态灯：接口在不在一眼看得出来，不用人去猜
        this.probeService()
    }

    startAmbient()
    {
        if(this.ambientTimer)
            return

        this.ambientTimer = setInterval(() => this.syncAmbient(), AMBIENT_INTERVAL)
        this.syncAmbient()
    }

    /**
     * 把 dayCycles 当前这一格颜色写进 CSS 变量。一整圈才 4 分钟，盯着看能发现
     * 幕布在慢慢变冷 / 变暖；三百毫秒一跳就够了，不必逐帧。
     */
    syncAmbient()
    {
        const day = this.game?.dayCycles

        if(!day || !this.element)
            return

        // 门禁期间把开场的地上文字与加载环藏起来，别跟登录卡抢戏（可能刚被建出来）
        const intro = this.game.world?.intro

        if(this.gated && intro)
        {
            if(intro.label?.visible)
            {
                intro.label.visible = false
                this.introWasVisible.label = true
            }

            if(intro.circle?.mesh?.visible)
                intro.circle.mesh.visible = false
        }

        const properties = day.properties || {}
        const tint = properties.fogColorA?.value ?? properties.fogColorB?.value
        const glow = properties.lightColor?.value

        // 幕布要能看见后面的世界，所以写进去的都是带透明度的 rgba：
        // 天色那一层大约 0.58，光色只当一团辉光
        if(tint)
            this.element.style.setProperty('--account-tint', this.rgba(tint, 0.58))

        if(glow)
            this.element.style.setProperty('--account-glow', this.rgba(glow, 0.3))
    }

    rgba(color, opacity)
    {
        return `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${opacity})`
    }

    /**
     * 探一次账号服务。只问 /api/ping（永远回 200），这样控制台里不会为了
     * “确认服务在不在”而留一串 401；只有 fetch 本身报错（端口没人听）才算离线。
     */
    async probeService()
    {
        let online = true

        try
        {
            await fetch('/api/ping', { method: 'GET' })
        }
        catch
        {
            online = false
        }

        this.serviceOnline = online
        this.setConnection(online)

        // 服务没在跑：每 4 秒自己再问一次，一起来就马上变绿，不用人刷新页面
        if(!online && !this.probeTimer)
            this.probeTimer = setInterval(() => this.probeService(), PROBE_INTERVAL)
        else if(online && this.probeTimer)
        {
            clearInterval(this.probeTimer)
            this.probeTimer = null
        }
    }

    setConnection(online)
    {
        const pill = this.ui?.connection
        const text = this.ui?.connectionText

        if(!pill || !text)
            return

        pill.classList.toggle('is-online', !!online)
        pill.classList.toggle('is-retrying', !online)
        text.textContent = online
            ? 'Account service online'
            : 'Waiting for the account service… retrying automatically'
    }

    // 14：自己头顶先挂一枚名牌（以后多人复用同一个模板）
    mountNametag()
    {
        const container = this.ui?.nametags
        const nickname = this.getNickname()

        if(!container || !nickname || this.nametag || !this.game)
            return

        const tag = document.createElement('div')
        tag.className = 'nametag is-self'

        const avatar = document.createElement('span')
        avatar.className = 'nametag-avatar'

        const name = document.createElement('span')
        name.className = 'nametag-name'
        name.textContent = nickname

        tag.appendChild(avatar)
        tag.appendChild(name)
        container.appendChild(tag)

        this.nametag = tag

        this.game.ticker.events.on('tick', () => this.updateNametag(), 40)
        requestAnimationFrame(() => tag.classList.add('is-visible'))
    }

    updateNametag()
    {
        if(!this.nametag || !this.game?.view?.camera)
            return

        const character = this.game.character
        const onFoot = !!character?.object3D?.visible
        const anchor = onFoot ? character.object3D.position : this.game.player.position

        this.nametag.classList.toggle('is-vehicle', !onFoot)

        this.vector.set(anchor.x, anchor.y + (onFoot ? 1.75 : 1.15), anchor.z)
        this.vector.project(this.game.view.camera)

        const onScreen = this.vector.z < 1 && Math.abs(this.vector.x) < 0.95 && Math.abs(this.vector.y) < 0.9
        this.nametag.classList.toggle('is-offscreen', !onScreen)

        if(!onScreen)
            return

        const x = (this.vector.x * 0.5 + 0.5) * window.innerWidth
        const y = (-this.vector.y * 0.5 + 0.5) * window.innerHeight

        this.nametag.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
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
     * 等用户登录好。游戏已经先建起来了（当登录界面的实景），这里只是
     * 把界面亮出来、等一个成功的注册 / 登录。每次进来都要求登录。
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
        // 10：先播“把世界交出来”那一下，再真的把界面撤掉
        this.element?.classList.add('is-leaving')

        setTimeout(() => this.releaseGate(), LEAVE_DURATION)
    }

    /**
     * 真正结束门禁：解锁操作、恢复进度写入、把该露面的东西放回去。
     * 调到这里之前必须已经把服务器进度合并进 localStorage 了。
     */
    releaseGate()
    {
        this.releaseWrites()

        if(this.game?.inputs)
            this.game.inputs.locked = false

        // 天色驱动只服务于登录界面，门禁一结束就停，别白占性能
        if(this.ambientTimer)
        {
            clearInterval(this.ambientTimer)
            this.ambientTimer = null
        }

        const intro = this.game?.world?.intro

        if(intro && this.introWasVisible.label)
            intro.label.visible = true

        document.body.classList.remove('is-account-gated')

        if(this.worldShell)
            this.worldShell.inert = false

        this.element?.classList.remove('is-visible', 'is-leaving')
        this.setStatus('')

        this.startAutoSync()
        this.mountNametag()

        if(this.ui?.name)
            this.ui.name.textContent = this.getNickname() || 'Sign out'

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
            this.setError(ERROR_TEXT.username, this.ui.username)
            this.ui.username?.focus()
            return
        }

        if(password.length < PASSWORD_MIN)
        {
            this.setError(ERROR_TEXT.password, this.ui.password)
            this.ui.password?.focus()
            return
        }

        // 这条前端先拦一道，省得白跑一趟服务器。
        // 只在注册时管：老账号的密码是无所谓跟用户名一样的，登录不能被它挡住。
        if(this.mode === 'register' && password.toLowerCase() === username.toLowerCase())
        {
            this.setError(ERROR_TEXT.sameAsUsername, this.ui.password)
            return
        }

        // 没有找回密码的途径，所以注册时输两遍，防止手滑打错
        if(this.mode === 'register' && password !== this.ui.confirm.value)
        {
            this.setError(ERROR_TEXT.match, this.ui.confirm)
            this.ui.confirm?.focus()
            return
        }

        const path = this.mode === 'register' ? '/api/register' : '/api/login'

        this.setBusy(true)
        const result = await this.request(path, { body: { username, password } })
        this.setBusy(false)

        if(!result.ok)
        {
            this.setError(ERROR_TEXT[result.error] || ERROR_TEXT.server, result.error === 'wrongPassword' ? this.ui.password : this.ui.username)

            // 连不上 / 服务端报错：立刻重探一次，状态灯跟着变，恢复了自己会亮绿
            if(result.error === 'network' || result.error === 'server')
                this.probeService()

            // 这个名字还没人注册，顺手把人引到"注册"那一栏
            if(result.error === 'notRegistered' && this.mode === 'login')
            {
                const keepPassword = this.ui.password.value

                this.setMode('register')
                this.setError(ERROR_TEXT.notRegistered, this.ui.username)
                this.ui.username.value = username
                this.ui.password.value = keepPassword
                this.ui.username?.focus()
            }

            return
        }

        this.token = result.data.token
        this.setUser(result.data.user)

        // 闸门先拆掉，否则下面合并好的进度会被自己的门禁拦得写不进去
        this.releaseWrites()

        // 本地可能还攒着没上传的进度（比如这台设备以前玩过），合并后再存回去
        const merged = this.mergeProgress(this.collectLocalProgress(), result.data.progress)
        this.applyProgress(merged)
        this.syncProgress(true)

        // 10：成功那一帧先给按钮一个成功态，再淡出把世界交出来
        this.ui.submit?.classList.add('is-success')
        this.setSubmitLabel(this.mode === 'register' ? 'Account created!' : `Welcome, ${username}!`)

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