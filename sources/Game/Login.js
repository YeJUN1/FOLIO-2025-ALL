import * as THREE from 'three/webgpu'
import gsap from 'gsap'
import { Game } from './Game.js'

/**
 * Local account system.
 *
 * Accounts live in localStorage (no server in this project), passwords are
 * stored as SHA-256 hashes. The very first successful verification of an
 * account grants 5000 points — once and only once per account.
 * A successful login teleports the player to the plot that account owns
 * (see `Territory.members`).
 */
export class Login
{
    static STORAGE_KEY = 'folioAccounts'
    static SESSION_KEY = 'folioSession'
    static FIRST_LOGIN_BONUS = 5000

    constructor()
    {
        this.game = Game.getInstance()

        this.modal = this.game.modals.items.get('login')
        this.element = this.modal ? this.modal.element : null
        this.current = null
        this.pendingSpawn = null

        if(this.element)
            this.setDom()

        this.restoreSession()

        // No saved session => ask for verification right away.
        // A restored session goes straight to the owner's plot instead.
        if(!this.current && this.modal)
            this.game.modals.open('login')

        this.game.ticker.events.on('tick', () =>
        {
            this.update()
        }, 15)
    }

    setDom()
    {
        this.form = this.element.querySelector('.js-login-form')
        this.profile = this.element.querySelector('.js-login-profile')
        this.nameInput = this.element.querySelector('.js-login-name')
        this.passwordInput = this.element.querySelector('.js-login-password')
        this.messageElement = this.element.querySelector('.js-login-message')
        this.submitButton = this.element.querySelector('.js-login-submit')
        this.registerButton = this.element.querySelector('.js-login-register')
        this.spawnButton = this.element.querySelector('.js-login-spawn')
        this.logoutButton = this.element.querySelector('.js-login-logout')
        this.profileName = this.element.querySelector('.js-login-profile-name')
        this.profilePoints = this.element.querySelector('.js-login-profile-points')
        this.profileTerritory = this.element.querySelector('.js-login-profile-territory')

        this.submitButton.addEventListener('click', () =>
        {
            this.submit('login')
        })

        this.registerButton.addEventListener('click', () =>
        {
            this.submit('register')
        })

        this.spawnButton.addEventListener('click', () =>
        {
            this.goToTerritory(true)
        })

        this.logoutButton.addEventListener('click', () =>
        {
            this.logout()
        })

        this.passwordInput.addEventListener('keydown', (event) =>
        {
            if(event.code === 'Enter' || event.code === 'NumpadEnter')
            {
                event.preventDefault()
                this.submit('login')
            }
        })

        // Reopen from the options panel
        const trigger = document.querySelector('.js-login-trigger')

        if(trigger)
        {
            trigger.addEventListener('click', () =>
            {
                this.game.modals.open('login')
            })
        }
    }

    update()
    {
        if(!this.pendingSpawn)
            return

        if(!this.game.player || !this.game.overlay || !this.game.physicalVehicle)
            return

        // Wait for the intro to be ready before skipping it
        if(!this.game.reveal || this.game.reveal.step === - 1)
            return

        // The territory exists by now even if it didn't during the constructor
        if(this.current && this.game.territory)
            this.renderProfile()

        const name = this.pendingSpawn
        this.pendingSpawn = null

        // Logging in counts as the intro's "start": leave the landing screen
        // and let the game switch to the normal driving view before respawning.
        // The intro's own circle animation takes 1.5s, so step 1 has to wait for
        // it to finish — otherwise the two zoom animations overwrite each other
        // and the reveal stays stuck on the intro view.
        if(this.game.reveal.step === 0)
        {
            const reveal = this.game.reveal

            gsap.delayedCall(1.7, () =>
            {
                if(reveal.step === 0)
                    reveal.updateStep(1)
            })
        }

        this.respawnAtMember(name)
    }

    readStore()
    {
        try
        {
            const store = JSON.parse(localStorage.getItem(Login.STORAGE_KEY))

            if(store && typeof store.accounts === 'object' && store.accounts !== null)
                return store
        }
        catch(error)
        {
            // Corrupted storage => start over
        }

        return { accounts: {} }
    }

    writeStore(store)
    {
        localStorage.setItem(Login.STORAGE_KEY, JSON.stringify(store))
    }

    normalize(_name)
    {
        return _name.trim().toLowerCase()
    }

    async hash(_name, _password)
    {
        const data = new TextEncoder().encode(`${this.normalize(_name)}\\u0000${_password}`)

        if(crypto.subtle)
        {
            const buffer = await crypto.subtle.digest('SHA-256', data)

            return Array.from(new Uint8Array(buffer))
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('')
        }

        // crypto.subtle is unavailable outside secure contexts
        let hash = 0

        for(const byte of data)
            hash = (hash * 31 + byte) >>> 0

        return `fallback-${hash.toString(16)}`
    }

    async submit(_mode)
    {
        if(!this.form || this.form.classList.contains('is-disabled'))
            return

        const name = this.nameInput.value.trim()
        const password = this.passwordInput.value

        if(name.length < 1)
        {
            this.showMessage('先输入你的名字')
            this.nameInput.focus()
            return
        }

        if(name.length > 16)
        {
            this.showMessage('名字最多 16 个字')
            this.nameInput.focus()
            return
        }

        if(password.length < 4)
        {
            this.showMessage('密码至少要 4 位')
            this.passwordInput.focus()
            return
        }

        this.setBusy(true)

        const store = this.readStore()
        const key = this.normalize(name)
        const passwordHash = await this.hash(name, password)

        if(_mode === 'register')
        {
            if(store.accounts[key])
            {
                this.showMessage('这个名字已经有账号了，点「登录」试试')
                this.setBusy(false)
                return
            }

            const account = {
                key,
                name,
                passwordHash,
                points: 0,
                firstBonusClaimed: false,
                createdAt: Date.now(),
                lastLoginAt: null,
            }

            store.accounts[key] = account
            this.writeStore(store)
            this.signIn(account)
        }
        else
        {
            const account = store.accounts[key]

            if(!account)
            {
                this.showMessage('没有找到这个账号，点「创建账号」新建一个')
                this.setBusy(false)
                return
            }

            if(account.passwordHash !== passwordHash)
            {
                this.showMessage('密码不对，再试一次')
                this.setBusy(false)
                return
            }

            this.signIn(account)
        }

        this.setBusy(false)
    }

    signIn(_account)
    {
        const store = this.readStore()
        const account = store.accounts[_account.key] || _account
        const isFirstVerification = !account.firstBonusClaimed

        if(isFirstVerification)
        {
            account.points += Login.FIRST_LOGIN_BONUS
            account.firstBonusClaimed = true
        }

        account.lastLoginAt = Date.now()
        store.accounts[account.key] = account
        this.writeStore(store)
        localStorage.setItem(Login.SESSION_KEY, account.key)

        this.current = account
        this.renderProfile()
        this.passwordInput.value = ''

        if(isFirstVerification)
        {
            this.showMessage(`验证成功！第一次登录奖励 +${Login.FIRST_LOGIN_BONUS} 积分`, 'success')

            this.game.notifications.show(
                /* html */`
                    <div class="top">
                        <div class="title">身份验证成功</div>
                    </div>
                    <div class="bottom">
                        <div class="description">${account.name} · 首次登录 +${Login.FIRST_LOGIN_BONUS} 积分</div>
                    </div>
                `,
                'login-bonus',
                6,
                null,
                'login-bonus'
            )
        }
        else
        {
            this.showMessage(`欢迎回来，当前积分 ${account.points}`, 'success')

            this.game.notifications.show(
                /* html */`
                    <div class="top">
                        <div class="title">欢迎回来，${account.name}</div>
                    </div>
                    <div class="bottom">
                        <div class="description">当前积分 ${account.points}</div>
                    </div>
                `,
                'login-welcome',
                5,
                null,
                'login-welcome'
            )
        }

        this.game.modals.close()
        this.pendingSpawn = account.name
    }

    logout()
    {
        localStorage.removeItem(Login.SESSION_KEY)
        this.current = null
        this.pendingSpawn = null
        this.form.classList.remove('is-hidden')
        this.profile.classList.remove('is-visible')
        this.showMessage('已退出登录')
    }

    restoreSession()
    {
        const key = localStorage.getItem(Login.SESSION_KEY)

        if(!key)
            return

        const store = this.readStore()
        const account = store.accounts[key]

        if(!account)
        {
            localStorage.removeItem(Login.SESSION_KEY)
            return
        }

        account.lastLoginAt = Date.now()
        this.writeStore(store)

        this.current = account
        this.renderProfile()
        this.pendingSpawn = account.name
    }

    renderProfile()
    {
        if(!this.form || !this.current)
            return

        this.form.classList.add('is-hidden')
        this.profile.classList.add('is-visible')

        const member = this.game.territory ? this.game.territory.getMember(this.current.name) : null

        this.profileName.textContent = this.current.name
        this.profilePoints.textContent = `${this.current.points} 积分`
        this.profileTerritory.textContent = member
            ? `你的地盘：${member.name}（${this.describePlot(member.plot)}）`
            : '这个账号还没有分配地盘，登录后会送到 Landing'

        this.spawnButton.textContent = member ? '回到我的地盘' : '去 Landing'
    }

    describePlot(_plot)
    {
        return `x ${_plot.minX}~${_plot.maxX}，z ${_plot.minZ}~${_plot.maxZ}`
    }

    goToTerritory(_announce = false)
    {
        if(!this.current)
            return

        if(_announce)
            this.game.modals.close()

        this.respawnAtMember(this.current.name)
    }

    respawnAtMember(_name)
    {
        if(!this.game.player || !this.game.overlay || !this.game.physicalVehicle)
            return

        const member = this.game.territory ? this.game.territory.getMember(_name) : null

        if(!member)
        {
            this.game.player.respawn('landing')
            this.game.notifications.show(
                /* html */`
                    <div class="top">
                        <div class="title">${_name}</div>
                    </div>
                    <div class="bottom">
                        <div class="description">这个账号还没有地盘，先送到 Landing</div>
                    </div>
                `,
                'login-territory',
                6,
                null,
                'login-territory'
            )
            return
        }

        if(member.spawnName)
        {
            this.game.player.respawn(member.spawnName)
        }
        else
        {
            this.spawnAt(member.spawn)
        }

        this.game.notifications.show(
            /* html */`
                <div class="top">
                    <div class="title">已回到你的地盘</div>
                </div>
                <div class="bottom">
                    <div class="description">${member.name} · 积分 ${this.current ? this.current.points : 0}</div>
                </div>
            `,
            'login-territory',
            6,
            null,
            'login-territory'
        )
    }

    spawnAt(_coordinates)
    {
        const heights = this.game.world.floor.physical.colliders[0].shape.heights
        const rows = Math.round(Math.sqrt(heights.length))
        const size = this.game.terrain.size
        const indexX = Math.round(((_coordinates.x / size) + 0.5) * (rows - 1))
        const indexZ = Math.round(((_coordinates.z / size) + 0.5) * (rows - 1))
        const groundY = heights[indexZ + indexX * rows]

        const spawnName = 'login'

        this.game.respawns.items.set(spawnName, {
            name: spawnName,
            position: new THREE.Vector3(_coordinates.x, groundY + 4, _coordinates.z),
            rotation: _coordinates.rotation || 0,
        })

        this.game.player.respawn(spawnName)
    }

    setBusy(_busy)
    {
        if(!this.form)
            return

        this.form.classList.toggle('is-disabled', _busy)
        this.submitButton.disabled = _busy
        this.registerButton.disabled = _busy
    }

    showMessage(_text, _type = '')
    {
        if(!this.messageElement)
            return

        this.messageElement.textContent = _text
        this.messageElement.classList.remove('is-error', 'is-success')

        if(_type)
            this.messageElement.classList.add(`is-${_type}`)
    }
}
