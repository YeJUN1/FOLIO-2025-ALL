import { clamp } from 'three/src/math/MathUtils.js'
import { Game } from './Game.js'

export class Map
{
    constructor()
    {
        this.game = Game.getInstance()

        this.initiated = false
        this.modal = this.game.modals.items.get('map')
        this.element = this.modal.element.querySelector('.js-map-container')

        this.setTrigger()
        this.setInputs()

        this.modal.events.on('open', () =>
        {
            if(!this.initiated)
                this.init()
            else
                this.updateOwnership()

            this.texture.update()
        })
    }

    init()
    {
        this.initiated = true
        
        this.setTerritoryOverlay()
        this.setLocations()
        this.updateOwnership()
        this.setPlayer()
        this.setTexture()

        this.game.ticker.events.on('tick', () =>
        {
            this.update()
        }, 14)
    }

    setLocations()
    {
        this.locations = {}
        this.locations.items = [
            { name: 'Achievements', respawnName: 'achievements', offset: { x: 0, y: -0.01 } },
            { name: 'Altar', respawnName: 'altar', offset: { x: 0, y: -0.05 } },
            { name: 'Behind<br /> the scene', respawnName: 'behindTheScene', offset: { x: 0.01, y: 0 } },
            { name: 'Bowling', respawnName: 'bowling', offset: { x: -0.08, y: 0.03 } },
            { name: 'Career', respawnName: 'career', offset: { x: 0, y: -0.06 } },
            { name: 'Circuit', respawnName: 'circuit', offset: { x: -0.08, y: -0.05 } },
            { name: 'Cookie', respawnName: 'cookie', offset: { x: -0.02, y: -0.01 } },
            { name: 'Lab', respawnName: 'lab', offset: { x: -0.03, y: 0 } },
            { name: 'Landing', respawnName: 'landing', offset: { x: 0.02, y: 0 } },
            { name: 'Projects', respawnName: 'projects', offset: { x: 0, y: -0.02 } },
            { name: 'Social', respawnName: 'social', offset: { x: -0.01, y: -0.04 } },
            { name: 'Time Machine', respawnName: 'timeMachine', offset: { x: 0, y: 0 } },
        ]

        for(const item of this.locations.items)
        {
            const respawn = this.game.respawns.getByName(item.respawnName)
            const mapPosition = this.worldToMap(respawn.position)

            item.worldPosition = { x: respawn.position.x, z: respawn.position.z }

            // HTML
            const html = /* html */`
                <div class="pin"></div>
                <div class="name-container">
                    <div class="name">${item.name}</div>
                </div>
            `

            const element = document.createElement('div')
            element.classList.add('location')
            element.innerHTML = html
            element.style.left = `${(mapPosition.x + item.offset.x)* 100}%`
            element.style.top = `${(mapPosition.y + item.offset.y)* 100}%`
            element.style.zIndex = Math.round(mapPosition.y * 1000)
            
            this.element.append(element)
            item.element = element

            element.addEventListener('click', () =>
            {
                // Locations inside another player's plot are off limits
                if(item.locked)
                {
                    this.game.notifications.show(
                        /* html */`
                            <div class="title">不能进入</div>
                            <div class="description">这里是 ${item.ownerName} 的地盘</div>
                        `,
                        'map-locked',
                        4
                    )
                    return
                }

                this.game.player.respawn(item.respawnName, () =>
                {
                    this.game.view.focusPoint.isTracking = true
                })
                this.game.modals.close()
            })
        }
    }

    setTerritoryOverlay()
    {
        this.territoryOverlay = document.createElement('div')
        this.territoryOverlay.classList.add('territory-overlay')
        this.territoryOverlay.innerHTML = /* html */`
            <div class="label"></div>
        `
        this.territoryLabel = this.territoryOverlay.querySelector('.label')
        this.element.append(this.territoryOverlay)
    }

    getPlotAt(_position)
    {
        const territory = this.game.territory

        if(!territory || !territory.plots)
            return null

        return territory.plots.find((plot) =>
            _position.x >= plot.minX && _position.x <= plot.maxX &&
            _position.z >= plot.minZ && _position.z <= plot.maxZ
        ) || null
    }

    getPlotOwner(_plot)
    {
        const territory = this.game.territory

        if(!territory || !territory.members)
            return null

        for(const [ name, member ] of territory.members)
        {
            if(territory.plots[member.plot] === _plot)
                return name
        }

        return null
    }

    updateOwnership()
    {
        if(!this.territoryOverlay || !this.locations)
            return

        const login = this.game.login
        const accountName = login && login.current ? login.current.name : null
        const member = accountName ? this.game.territory.getMember(accountName) : null
        const myPlot = member ? member.plot : null

        // My plot is a translucent area drawn under the pins
        if(myPlot)
        {
            const topLeft = this.worldToMap({ x: myPlot.minX, z: myPlot.minZ })
            const bottomRight = this.worldToMap({ x: myPlot.maxX, z: myPlot.maxZ })

            this.territoryOverlay.style.left = `${topLeft.x * 100}%`
            this.territoryOverlay.style.top = `${topLeft.y * 100}%`
            this.territoryOverlay.style.width = `${(bottomRight.x - topLeft.x) * 100}%`
            this.territoryOverlay.style.height = `${(bottomRight.y - topLeft.y) * 100}%`
            this.territoryOverlay.style.display = 'block'
            this.territoryLabel.textContent = `${member.name} 的地盘`
        }
        else
        {
            this.territoryOverlay.style.display = 'none'
        }

        // Pins standing inside someone else's plot can't be clicked
        for(const item of this.locations.items)
        {
            const plot = this.getPlotAt(item.worldPosition)
            const ownerName = plot ? this.getPlotOwner(plot) : null
            const isMine = !!member && ownerName === member.name

            item.ownerName = ownerName
            item.locked = !!accountName && !!ownerName && !isMine
            item.element.classList.toggle('is-locked', item.locked)
        }
    }
    
    setPlayer()
    {
        this.player = {}
        this.player.element = this.element.querySelector('.js-player')
        this.player.roundedPosition = { x: 0, y: 0 }
    }
    
    setTexture()
    {
        this.texture = {}
        this.texture.element = this.element.querySelector('.js-texture')
        this.texture.previousUrl = null

        this.texture.element.addEventListener('load', () =>
        {
            this.texture.element.classList.add('is-visible')
        })
        
        this.texture.update = () =>
        {
            const url = this.game.dayCycles.intervalEvents.get('night').inInterval ? 'ui/map/map-night.webp' : 'ui/map/map-day.webp'

            if(url !== this.texture.previousUrl)
            {
                this.texture.element.classList.remove('is-visible')
                this.texture.previousUrl = url
                this.texture.element.src = url
            }
        }
    }

    setTrigger()
    {
        const element = this.game.domElement.querySelector('.js-map-trigger')
        
        element.addEventListener('click', (event) =>
        {
            this.game.modals.open('map')
        })
        element.addEventListener('keydown', (event) =>
        {
            event.preventDefault()
        })
    }

    setInputs()
    {
        // Inputs keyboard
        this.game.inputs.addActions([
            { name: 'map', categories: [ 'modal', 'menu', 'wandering' ], keys: [ 'Keyboard.m', 'Keyboard.KeyM' ] },
        ])
        this.game.inputs.events.on('map', (action) =>
        {
            if(action.active)
            {
                if(!this.modal.isOpen)
                    this.game.modals.open('map')
                else
                    this.game.modals.close()
            }
        })
    }

    worldToMap(coordinates)
    {
        let x = coordinates.x
        let y = typeof coordinates.z !== 'undefined' ? coordinates.z : coordinates.y

        x /= this.game.terrain.size
        y /= this.game.terrain.size

        x += 0.5
        y += 0.5

        x = clamp(x, 0, 1)
        y = clamp(y, 0, 1)

        return { x, y }
    }

    update()
    {
        if(!this.modal.isOpen)
            return

        const playerRoundedX = Math.round(this.game.player.position.x)
        const playerRoundedY = Math.round(this.game.player.position.z)

        if(playerRoundedX !== this.player.roundedPosition.x || playerRoundedY !== this.player.roundedPosition.y)
        {
            this.player.roundedPosition.x = playerRoundedX
            this.player.roundedPosition.y = playerRoundedY

            const playerCoordinates = this.worldToMap(this.player.roundedPosition)
            const x = Math.round(playerCoordinates.x * 1000) / 10
            const y = Math.round(playerCoordinates.y * 1000) / 10

            this.player.element.style.left = `${x}%`
            this.player.element.style.top = `${y}%`
            this.player.element.style.transform = `rotate(${-this.game.physicalVehicle.yRotation}rad)`
        }
    }
}