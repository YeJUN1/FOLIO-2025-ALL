import { Game } from './Game.js'
import gsap from 'gsap'
import { clamp } from 'three/src/math/MathUtils.js'
import achievementsData from '../data/achievements.js'
import { valueFor, TIERS } from './PointsConfig.js'
import { timeAgo } from './utilities/time.js'

// 访客没有登录账号，使用共享的旧存档（localStorage['achievements']）
const GUEST_KEY = '__guest__'

function escapeHtml(value)
{
    return String(value).replace(/[&<>"']/g, (character) =>
    {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
    })
}

export class Points
{
    constructor()
    {
        this.game = Game.getInstance()

        this.valueFor = valueFor
        this.tiers = TIERS
        this.max = 1
        this.current = 0
        this.gain = 0
        this.currentIndex = 0
        this.initial = true
        this.silent = false
        this.counted = new WeakSet()
        this.activePane = 'breakdown'

        // HUD 只在游戏开始后显示，样式（style/points.styl）里靠 html.is-started 控制，这里无需手动隐藏

        this.setSounds()
        this.setElement()

        // 积分完全从成就派生：首次全量算一遍
        this.computeFull()
        this.refresh()

        // 达成新成就 → 只加这一项（增量）；重置 / 切换账号 → 全量重算
        this.game.achievements.events.on('achieved', (achievement) =>
        {
            this.addAchievement(achievement)
            this.refresh()
        })
        this.game.achievements.events.on('reset', () =>
        {
            this.computeFull()
            this.refresh()
        })
        this.game.achievements.events.on('loaded', () =>
        {
            // 切号后静默刷新：不播飘字/升级音效
            this.silent = true
            this.computeFull()
            this.refresh()
            this.silent = false
        })
    }

    setSounds()
    {
        this.sounds = {}

        // 加分：复用成就奖励音（与 Achievements 同一份音频，安全）
        this.sounds.gain = this.game.audio.register({
            path: 'sounds/achievements/Money Reward 2.mp3',
            autoplay: false,
            loop: false,
            volume: 0.25,
            antiSpam: 0.3,
        })

        // 升级：复用彩带音效
        this.sounds.level = this.game.audio.register({
            path: 'sounds/swoosh/Swoosh 02.mp3',
            autoplay: false,
            loop: false,
            volume: 0.3,
            antiSpam: 0.3,
        })
    }

    setElement()
    {
        this.element = document.createElement('div')
        this.element.classList.add('points')
        this.element.innerHTML = /* html */`
            <div class="badge js-badge" role="button" tabindex="0" aria-expanded="false" aria-label="Points, breakdown and local leaderboard">
                <div class="row">
                    <span class="tier js-tier"></span>
                    <span class="level">Lv.<span class="level-number js-level">1</span></span>
                </div>
                <div class="score">
                    <span class="star">&#9733;</span>
                    <span class="value js-value">0</span>
                    <span class="gain js-gain"></span>
                </div>
                <div class="bar"><div class="bar-fill js-bar"></div></div>
                <div class="next js-next"></div>
                <div class="hint">Details</div>
            </div>
            <div class="panel js-panel">
                <div class="panel-top">
                    <div class="tabs">
                        <button class="tab js-tab is-active" data-tab="breakdown">Breakdown</button>
                        <button class="tab js-tab" data-tab="leaderboard">Leaderboard</button>
                    </div>
                    <button class="close js-close" aria-label="Close">&#215;</button>
                </div>
                <div class="panel-scroll js-panel-scroll">
                    <div class="pane js-pane-breakdown"></div>
                    <div class="pane js-pane-leaderboard"></div>
                </div>
            </div>
        `

        this.game.domElement.append(this.element)

        this.badgeElement = this.element.querySelector('.js-badge')
        this.tierElement = this.element.querySelector('.js-tier')
        this.levelElement = this.element.querySelector('.js-level')
        this.valueElement = this.element.querySelector('.js-value')
        this.gainElement = this.element.querySelector('.js-gain')
        this.barElement = this.element.querySelector('.js-bar')
        this.nextElement = this.element.querySelector('.js-next')

        this.panelElement = this.element.querySelector('.js-panel')
        this.panelScrollElement = this.element.querySelector('.js-panel-scroll')
        this.breakdownPaneElement = this.element.querySelector('.js-pane-breakdown')
        this.leaderboardPaneElement = this.element.querySelector('.js-pane-leaderboard')
        this.tabElements = [ ...this.element.querySelectorAll('.js-tab') ]

        // 点角标展开/收起
        this.badgeElement.addEventListener('click', (event) =>
        {
            event.preventDefault()
            event.stopPropagation()
            this.togglePanel()
        })
        this.badgeElement.addEventListener('keydown', (event) =>
        {
            if(event.key === 'Enter' || event.key === ' ')
            {
                event.preventDefault()
                this.togglePanel()
            }
        })

        // 面板内部点击不要冒泡到游戏画布
        this.panelElement.addEventListener('click', (event) =>
        {
            event.stopPropagation()
        })

        // 关闭按钮
        this.element.querySelector('.js-close').addEventListener('click', (event) =>
        {
            event.preventDefault()
            this.togglePanel(false)
        })

        // 页签切换
        for(const tabElement of this.tabElements)
        {
            tabElement.addEventListener('click', (event) =>
            {
                event.preventDefault()
                this.setPane(tabElement.dataset.tab)
            })
        }

        this.setPane('breakdown')
    }

    // ---- 面板 ----

    setPane(name)
    {
        this.activePane = name === 'leaderboard' ? 'leaderboard' : 'breakdown'

        for(const tabElement of this.tabElements)
        {
            const active = tabElement.dataset.tab === this.activePane
            tabElement.classList.toggle('is-active', active)
            tabElement.setAttribute('aria-selected', active ? 'true' : 'false')
        }

        this.breakdownPaneElement.hidden = this.activePane !== 'breakdown'
        this.leaderboardPaneElement.hidden = this.activePane !== 'leaderboard'
    }

    togglePanel(force)
    {
        const open = typeof force === 'boolean' ? force : !this.element.classList.contains('is-open')

        this.element.classList.toggle('is-open', open)
        this.badgeElement.setAttribute('aria-expanded', open ? 'true' : 'false')

        if(open)
            this.renderPanel()
    }

    renderPanel()
    {
        const scrollTop = this.panelScrollElement.scrollTop

        this.renderBreakdown()
        this.renderLeaderboard()

        this.panelScrollElement.scrollTop = scrollTop
    }

    renderBreakdown()
    {
        let achievedCount = 0
        let totalCount = 0
        let html = ''

        this.game.achievements.groups.forEach((group) =>
        {
            for(const achievement of group.items)
            {
                totalCount++

                const value = valueFor(achievement.total)
                const achieved = !!achievement.achieved

                if(achieved)
                    achievedCount++

                html += /* html */`
                    <div class="item ${achieved ? 'is-achieved' : ''}">
                        <span class="dot"></span>
                        <span class="name">${escapeHtml(achievement.title ?? 'Achievement')}</span>
                        <span class="value">${achieved ? '+' : ''}${value}</span>
                    </div>
                `
            }
        })

        this.breakdownPaneElement.innerHTML = /* html */`
            <div class="summary">
                <div class="summary-score">${this.current.toLocaleString('en-US')}<span> / ${this.max.toLocaleString('en-US')}</span></div>
                <div class="summary-meta">${achievedCount} / ${totalCount} achievements</div>
            </div>
            <div class="list">${html}</div>
        `
    }

    renderLeaderboard()
    {
        const entries = this.getLeaderboard()
        let html = ''

        if(!entries.length)
        {
            html = /* html */`<div class="empty">No scores yet</div>`
        }
        else
        {
            for(const entry of entries)
            {
                const lastActive = entry.lastActive ? timeAgo(entry.lastActive) : ''

                html += /* html */`
                    <div class="board-row ${entry.current ? 'is-current' : ''}">
                        <span class="rank">${entry.rank}</span>
                        <span class="name">${escapeHtml(entry.name)}</span>
                        <span class="tier">${entry.tier} · Lv.${entry.level}${lastActive ? ` · ${escapeHtml(lastActive)}` : ''}</span>
                        <span class="value">${entry.score.toLocaleString('en-US')}</span>
                    </div>
                `
            }

            html += /* html */`<div class="note">${entries.length} player${entries.length > 1 ? 's' : ''} on this device</div>`
        }

        this.leaderboardPaneElement.innerHTML = html
    }

    // ---- 积分计算 ----

    // 全量扫描所有成就，累加「可达总分」与「当前得分」
    computeFull()
    {
        const previous = this.current
        let max = 0
        let current = 0

        this.counted = new WeakSet()

        this.game.achievements.groups.forEach((group) =>
        {
            for(const achievement of group.items)
            {
                const value = valueFor(achievement.total)
                max += value

                if(achievement.achieved)
                {
                    current += value
                    this.counted.add(achievement)
                }
            }
        })

        this.max = Number.isFinite(max) && max > 0 ? max : 1
        this.current = Number.isFinite(current) && current > 0 ? current : 0
        this.gain = this.current - previous
    }

    // 增量：新达成一个成就时只加它这一项
    addAchievement(achievement)
    {
        if(!achievement || this.counted.has(achievement))
            return

        this.counted.add(achievement)

        const value = valueFor(achievement.total)
        const current = Number.isFinite(this.current) ? this.current : 0

        this.current = Math.max(0, current + value)
        this.gain = value

        // 得分即视为该账号活跃，刷新“最后活跃”时间
        this.game.login?.touch?.()
    }

    tierFor(ratio)
    {
        const safeRatio = Number.isFinite(ratio) ? ratio : 0
        let index = 0

        for(let i = 0; i < TIERS.length; i++)
        {
            if(safeRatio >= TIERS[i].at)
                index = i
        }

        return index
    }

    refresh()
    {
        const ratio = this.max > 0 ? clamp(this.current / this.max, 0, 1) : 0
        const index = this.tierFor(ratio)
        const tier = TIERS[index]
        const next = TIERS[index + 1]

        // 数值滚动
        this.animateValue(this.current)

        // 等级 / 称号
        this.tierElement.textContent = tier.name
        this.levelElement.textContent = index + 1

        // 进度条：当前等级内的推进比例
        const spanStart = tier.at
        const spanEnd = next ? next.at : 1
        const within = spanEnd > spanStart ? (ratio - spanStart) / (spanEnd - spanStart) : 1
        this.barElement.style.transform = `scaleX(${clamp(within, 0, 1)})`

        // 距下一级还差多少分
        if(next)
        {
            const nextPoints = Math.round(this.max * next.at)
            const remaining = Math.max(0, nextPoints - this.current)
            this.nextElement.textContent = `${remaining.toLocaleString('en-US')} to ${next.name}`
        }
        else
        {
            this.nextElement.textContent = 'Max tier'
        }

        // 反馈：仅在实际加分、且非首次渲染/非切号时播放
        if(!this.initial && !this.silent && this.gain > 0)
        {
            this.showGain(this.gain)

            if(index > this.currentIndex)
                this.onLevelUp()
        }

        this.currentIndex = index
        this.initial = false
        this.gain = 0

        // 面板展开时同步刷新内容（保留滚动位置）
        if(this.element.classList.contains('is-open'))
            this.renderPanel()
    }

    animateValue(target)
    {
        const safeTarget = Number.isFinite(target) ? target : 0
        const parsed = parseInt(this.valueElement.textContent.replace(/[^0-9]/g, ''), 10)
        const from = Number.isFinite(parsed) ? parsed : 0
        const proxy = { v: from }

        gsap.to(proxy,
        {
            v: safeTarget,
            duration: 1,
            ease: 'power1.out',
            overwrite: true,
            onUpdate: () =>
            {
                this.valueElement.textContent = Math.round(proxy.v).toLocaleString('en-US')
            }
        })
    }

    showGain(gain)
    {
        const amount = Math.max(0, Math.round(Number(gain) || 0))

        if(!amount)
            return

        this.sounds.gain.play()

        // +N 飘字（重播 CSS 动画）
        this.gainElement.textContent = `+${amount}`
        this.gainElement.classList.remove('is-showing')
        void this.gainElement.offsetWidth
        this.gainElement.classList.add('is-showing')

        // 角标轻微弹一下
        gsap.fromTo(this.element, { scale: 1.1 }, { scale: 1, duration: 0.5, ease: 'back.out(3)', overwrite: true })
    }

    onLevelUp()
    {
        this.sounds.level.play()

        this.element.classList.add('is-up')

        window.setTimeout(() =>
        {
            this.element.classList.remove('is-up')
        }, 1400)
    }

    // ---- 多人（本机多账号）排行榜 ----

    getCurrentKey()
    {
        return this.game.login?.userKey ?? GUEST_KEY
    }

    accountStorageKey(key)
    {
        return key === GUEST_KEY ? 'achievements' : 'achievements:' + key
    }

    readStorage(key)
    {
        try
        {
            const raw = localStorage.getItem(key)
            const parsed = raw ? JSON.parse(raw) : null

            return parsed && typeof parsed === 'object' ? parsed : null
        }
        catch
        {
            return null
        }
    }

    // 依据某个账号的成就存档计算积分（不依赖该账号当前是否在线）
    scoreForAccount(key)
    {
        const stored = this.readStorage(this.accountStorageKey(key))

        if(!stored)
            return 0

        const groupProgress = {}

        for(const groupName in stored)
        {
            const raw = stored[groupName]
            const progress = Array.isArray(raw) ? raw.length : Number(raw)
            groupProgress[groupName] = Number.isFinite(progress) && progress > 0 ? progress : 0
        }

        let score = 0

        for(const row of achievementsData)
        {
            const groupName = row[0]
            const total = Number(row[3])

            if(!Number.isFinite(total) || total < 1)
                continue

            const progress = groupProgress[groupName] ?? 0

            if(progress >= total)
                score += valueFor(total)
        }

        return score
    }

    getLeaderboard()
    {
        const currentKey = this.getCurrentKey()
        const users = this.game.login?.getUsers?.() ?? {}
        const entries = []

        const build = (key, name) =>
        {
            const current = key === currentKey

            // 当前账号以内存中的实时分数为准（存档可能还没写入本次加分）
            const score = current ? this.current : this.scoreForAccount(key)
            const ratio = this.max > 0 ? clamp(score / this.max, 0, 1) : 0
            const index = this.tierFor(ratio)

            return {
                key,
                name: name || key,
                score,
                tier: TIERS[index].name,
                level: index + 1,
                lastActive: this.game.login?.getLastActive?.(key) ?? null,
                current
            }
        }

        // 访客：有存档或当前就是访客时才上榜
        if(currentKey === GUEST_KEY || this.readStorage(this.accountStorageKey(GUEST_KEY)))
            entries.push(build(GUEST_KEY, 'Guest'))

        for(const key in users)
            entries.push(build(key, users[key]?.username ?? key))

        entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

        for(let i = 0; i < entries.length; i++)
            entries[i].rank = i + 1

        return entries
    }
}
