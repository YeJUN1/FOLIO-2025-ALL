import * as THREE from 'three/webgpu'

import { Debug } from './Debug.js'
import { Inputs } from './Inputs/Inputs.js'
import { Physics } from './Physics/Physics.js'
import { Rendering } from './Rendering.js'
import { ResourcesLoader } from './ResourcesLoader.js'
import { Ticker } from './Ticker.js'
import { Time } from './Time.js'
import { Player } from './Player.js'
import { Character } from './Character.js'
import { View } from './View.js'
import { Viewport } from './Viewport.js'
import { World } from './World/World.js'
import { Tracks } from './Tracks.js'
// import { Monitoring } from './Monitoring.js'
import { Lighting } from './Ligthing.js'
import { Materials } from './Materials.js'
import { Objects } from './Objects.js'
import { Fog } from './Fog.js'
import { DayCycles } from './Cycles/DayCycles.js'
import { Weather } from './Weather.js'
import { Noises } from './Noises.js'
import { Wind } from './Wind.js'
import { Terrain } from './Terrain.js'
import { Explosions } from './Explosions.js'
import { YearCycles } from './Cycles/YearCycles.js'
import { Server } from './Server.js'
import { Modals } from './Modals.js'
import { PhysicsVehicle } from './Physics/PhysicsVehicle.js'
import { PhysicsWireframe } from './Physics/PhysicsWireframe.js'
import { Zones } from './Zones.js'
import { Territory } from './Territory.js'
import { TerritoryFence } from './World/TerritoryFence.js'
import { Overlay } from './Overlay.js'
import { Tornado } from './Tornado.js'
import { InteractivePoints } from './InteractivePoints.js'
import { Respawns } from './Respawns.js'
import { Audio } from './Audio.js'
import { ClosingManager } from './ClosingManager.js'
import { RayCursor } from './RayCursor.js'
import { Water } from './Water.js'
import { Reveal } from './Reveal.js'
import { KonamiCode } from './KonamiCode.js'
import { Achievements } from './Achievements.js'
import { Notifications } from './Notifications.js'
import { Quality } from './Quality.js'
import { Menu } from './Menu.js'
import { Title } from './Title.js'
import { PreRenderer } from './PreRenderer.js'
import { Options } from './Options.js'
import gsap from 'gsap'
import { Map } from './Map.js'
import { Train } from './World/Train.js'

export class Game
{
    static getInstance()
    {
        return Game.instance
    }

    constructor()
    {
        // Singleton
        if(Game.instance)
            return Game.instance

        Game.instance = this

        this.init()
    }

    async init()
    {
        // Setup
        this.domElement = document.querySelector('.game')
        this.canvasElement = this.domElement.querySelector('.js-canvas')
        document.documentElement.classList.add('is-started')

        // First batch for intro
        this.scene = new THREE.Scene()
        this.debug = new Debug()
        this.resourcesLoader = new ResourcesLoader()
        this.quality = new Quality()
        this.server = new Server()
        this.ticker = new Ticker()
        this.time = new Time()
        this.dayCycles = new DayCycles()
        this.yearCycles = new YearCycles()
        this.inputs = new Inputs([], [ 'intro' ])
        this.audio = new Audio()
        this.notifications = new Notifications()
        this.rayCursor = new RayCursor()
        this.viewport = new Viewport(this.domElement)
        this.modals = new Modals()
        this.menu = new Menu()
        this.rendering = new Rendering()
        await this.rendering.setRenderer()

        const compressed = !!import.meta.env.VITE_COMPRESSED
        const compressedModelSuffix = compressed ? '-compressed' : ''
        const compressedTextureFormat = compressed ? 'textureKtx' : 'texture'
        const compressedTextureExtension = compressed ? 'ktx' : 'png'

        const cb = '?cb=1'
        this.resources = await this.resourcesLoader.load([
            [ 'respawnsReferencesModel',    `respawns/respawnsReferences${compressedModelSuffix}.glb${cb}`, 'gltf' ],
            [ 'behindTheSceneStarsTexture', `behindTheScene/stars.${compressedTextureExtension}${cb}`,      compressedTextureFormat, (resource) => { resource.colorSpace = THREE.SRGBColorSpace; resource.minFilter = THREE.NearestFilter; resource.magFilter = THREE.NearestFilter; resource.generateMipmaps = false; resource.wrapS = THREE.RepeatWrapping; resource.wrapT = THREE.RepeatWrapping; } ],
            [ 'soundTexture',               `intro/sound.${compressedTextureExtension}${cb}`,               compressedTextureFormat, (resource) => { resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false; resource.repeat.x = 0.5; } ],
            [ 'paletteTexture',             `palette.${compressedTextureExtension}${cb}`,                   compressedTextureFormat, (resource) => { resource.minFilter = THREE.NearestFilter; resource.magFilter = THREE.NearestFilter; resource.generateMipmaps = false; resource.colorSpace = THREE.SRGBColorSpace; } ],

        ])
        this.options = new Options()
        this.respawns = new Respawns(import.meta.env.VITE_PLAYER_SPAWN || 'landing')
        this.view = new View()
        this.rendering.setPostprocessing()
        this.rendering.start()
        this.reveal = new Reveal()
        this.noises = new Noises()
        this.weather = new Weather()
        this.wind = new Wind()
        this.tracks = new Tracks()
        this.lighting = new Lighting()
        this.fog = new Fog()
        this.water = new Water()
        this.materials = new Materials()
        this.objects = new Objects()
        this.explosions = new Explosions()
        this.world = new World()

        // Load and init RAPIER
        const rapierPromise = import('@dimforge/rapier3d')

        // Load rest of resources
        const resourcesPromise = this.resourcesLoader.load(
            [
                [ 'foliageTexture',                        `foliage/foliageSDF.${compressedTextureExtension}${cb}`,                              compressedTextureFormat, (resource) => { resource.minFilter = THREE.NearestFilter; resource.magFilter = THREE.NearestFilter; resource.generateMipmaps = false; } ],
                [ 'bushesReferences',                      `bushes/bushesReferences${compressedModelSuffix}.glb${cb}`,                           'gltf' ],
                [ 'vehicle',                               `vehicle/revuelto${compressedModelSuffix}.glb${cb}`,                                  'gltf' ],
                [ 'playgroundVisual',                      `playground/playgroundVisual${compressedModelSuffix}.glb${cb}`,                       'gltf' ],
                [ 'playgroundPhysical',                    `playground/playgroundPhysical${compressedModelSuffix}.glb${cb}`,                     'gltf' ],
                [ 'flowersReferencesModel',                `flowers/flowersReferences${compressedModelSuffix}.glb${cb}`,                         'gltf' ],
                [ 'bricksModel',                           `bricks/bricks${compressedModelSuffix}.glb${cb}`,                                     'gltf' ],
                [ 'fencesModel',                           `fences/fences${compressedModelSuffix}.glb${cb}`,                                     'gltf' ],
                [ 'benchesModel',                          `benches/benches${compressedModelSuffix}.glb${cb}`,                                   'gltf' ],
                [ 'explosiveCratesModel',                  `explosiveCrates/explosiveCrates${compressedModelSuffix}.glb${cb}`,                   'gltf' ],
                [ 'lanternsModel',                         `lanterns/lanterns${compressedModelSuffix}.glb${cb}`,                                 'gltf' ],
                [ 'terrainTexture',                        `terrain/terrain.${compressedTextureExtension}${cb}`,                                 compressedTextureFormat, (resource) => { resource.flipY = false; } ],
                [ 'terrainModel',                          `terrain/terrain${compressedModelSuffix}.glb${cb}`,                                   'gltf' ],
                [ 'floorSlabsTexture',                     `floor/slabs.${compressedTextureExtension}`,                                     compressedTextureFormat, (resource) => { resource.wrapS = THREE.RepeatWrapping; resource.wrapT = THREE.RepeatWrapping; resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false } ],
                [ 'birchTreesVisualModel',                 `birchTrees/birchTreesVisual${compressedModelSuffix}.glb${cb}`,                       'gltf' ],
                [ 'birchTreesReferencesModel',             `birchTrees/birchTreesReferences${compressedModelSuffix}.glb${cb}`,                   'gltf' ],
                [ 'oakTreesVisualModel',                   `oakTrees/oakTreesVisual${compressedModelSuffix}.glb${cb}`,                           'gltf' ],
                [ 'oakTreesReferencesModel',               `oakTrees/oakTreesReferences${compressedModelSuffix}.glb${cb}`,                                               'gltf' ],
                [ 'cherryTreesVisualModel',                `cherryTrees/cherryTreesVisual${compressedModelSuffix}.glb${cb}`,                     'gltf' ],
                [ 'cherryTreesReferencesModel',            `cherryTrees/cherryTreesReferences${compressedModelSuffix}.glb${cb}`,                 'gltf' ],
                [ 'sceneryModel',                          `scenery/scenery${compressedModelSuffix}.glb${cb}`,                                   'gltf' ],
                [ 'spidermanModel',                        `spiderman/spiderman${compressedModelSuffix}.glb${cb}`,                              'gltf' ],
                [ 'areasModel',                            `areas/areas${compressedModelSuffix}.glb${cb}`,                                       'gltf' ],
                [ 'poleLightsModel',                       `poleLights/poleLights${compressedModelSuffix}.glb${cb}`,                             'gltf' ],
                [ 'whisperFlameTexture',                   `whispers/whisperFlame.${compressedTextureExtension}${cb}`,                           compressedTextureFormat, (resource) => { resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false } ],
                [ 'satanStarTexture',                      `areas/satanStar.${compressedTextureExtension}${cb}`,                                 compressedTextureFormat, (resource) => { resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false } ],
                [ 'tornadoPathReferencesModel',            `tornado/tornadoPathReferences${compressedModelSuffix}.glb${cb}`,                     'gltf' ],
                [ 'overlayPatternTexture',                 `overlay/overlayPattern.${compressedTextureExtension}${cb}`,                          compressedTextureFormat, (resource) => { resource.wrapS = THREE.RepeatWrapping; resource.wrapT = THREE.RepeatWrapping; resource.magFilter = THREE.NearestFilter; resource.minFilter = THREE.NearestFilter; resource.generateMipmaps = false } ],
                [ 'interactivePointsKeyIconCrossTexture',  `interactivePoints/interactivePointsKeyIconCross.${compressedTextureExtension}${cb}`, compressedTextureFormat, (resource) => { resource.minFilter = THREE.NearestFilter; resource.magFilter = THREE.NearestFilter; resource.generateMipmaps = false } ],
                [ 'interactivePointsKeyIconEnterTexture',  `interactivePoints/interactivePointsKeyIconEnter.${compressedTextureExtension}${cb}`, compressedTextureFormat, (resource) => { resource.minFilter = THREE.NearestFilter; resource.magFilter = THREE.NearestFilter; resource.generateMipmaps = false } ],
                [ 'interactivePointsKeyIconATexture',      `interactivePoints/interactivePointsKeyIconA.${compressedTextureExtension}${cb}`,     compressedTextureFormat, (resource) => { resource.minFilter = THREE.NearestFilter; resource.magFilter = THREE.NearestFilter; resource.generateMipmaps = false } ],
                [ 'jukeboxMusicNotes',                     `jukebox/jukeboxMusicNotes.${compressedTextureExtension}${cb}`,                       compressedTextureFormat, (resource) => { resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false } ],
                [ 'achievementsGlyphsTexture',             `achievements/glyphs.${compressedTextureExtension}${cb}`,                             compressedTextureFormat, (resource) => { resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false; resource.wrapS = THREE.RepeatWrapping; } ],
                [ 'careerFreelancerTexture',               `career/careerFreelancer.${compressedTextureExtension}${cb}`,                         compressedTextureFormat, (resource) => { resource.flipY = false; resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false; resource.wrapS = THREE.ClampToEdgeWrapping; resource.wrapT = THREE.ClampToEdgeWrapping; } ],
                [ 'careerHeticTexture',                    `career/careerHetic.${compressedTextureExtension}${cb}`,                              compressedTextureFormat, (resource) => { resource.flipY = false; resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false; resource.wrapS = THREE.ClampToEdgeWrapping; resource.wrapT = THREE.ClampToEdgeWrapping; } ],
                [ 'careerImmersiveGardenTexture',          `career/careerImmersiveGarden.${compressedTextureExtension}${cb}`,                    compressedTextureFormat, (resource) => { resource.flipY = false; resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false; resource.wrapS = THREE.ClampToEdgeWrapping; resource.wrapT = THREE.ClampToEdgeWrapping; } ],
                [ 'careerIRLTeacherTexture',               `career/careerIRLTeacher.${compressedTextureExtension}${cb}`,                         compressedTextureFormat, (resource) => { resource.flipY = false; resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false; resource.wrapS = THREE.ClampToEdgeWrapping; resource.wrapT = THREE.ClampToEdgeWrapping; } ],
                [ 'careerOnlineTeacherTexture',            `career/careerOnlineTeacher.${compressedTextureExtension}${cb}`,                      compressedTextureFormat, (resource) => { resource.flipY = false; resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false; resource.wrapS = THREE.ClampToEdgeWrapping; resource.wrapT = THREE.ClampToEdgeWrapping; } ],
                [ 'careerUzikTexture',                     `career/careerUzik.${compressedTextureExtension}${cb}`,                               compressedTextureFormat, (resource) => { resource.flipY = false; resource.minFilter = THREE.LinearFilter; resource.magFilter = THREE.LinearFilter; resource.generateMipmaps = false; resource.wrapS = THREE.ClampToEdgeWrapping; resource.wrapT = THREE.ClampToEdgeWrapping; } ],
                [ 'timeMachineScreenMGSTexture',           `timeMachine/timeMachineScreenMGS.${compressedTextureExtension}${cb}`,                compressedTextureFormat, (resource) => { resource.minFilter = THREE.NearestFilter; resource.magFilter = THREE.NearestFilter; resource.generateMipmaps = false; resource.wrapS = THREE.ClampToEdgeWrapping; resource.wrapT = THREE.ClampToEdgeWrapping; resource.colorSpace = THREE.SRGBColorSpace; } ],
                [ 'timeMachineScreenFolioTexture',         `timeMachine/timeMachineScreenFolio.${compressedTextureExtension}${cb}`,              compressedTextureFormat, (resource) => { resource.minFilter = THREE.NearestFilter; resource.magFilter = THREE.NearestFilter; resource.generateMipmaps = false; resource.wrapS = THREE.ClampToEdgeWrapping; resource.wrapT = THREE.ClampToEdgeWrapping; resource.colorSpace = THREE.SRGBColorSpace; } ],
                [ 'characterModel',                        `character/character${compressedModelSuffix}.glb${cb}`,                               'gltf' ],
                [ 'pandoraFenceModel', `fences/bambooFence.glb${cb}`, 'gltf' ],
               
            ],
            (toLoad, total) =>
            {
                this.world.intro.updateProgress(1 - toLoad / total)
            }
        )

        const [ newResources, RAPIER ] = await Promise.all([ resourcesPromise, rapierPromise ])
        this.RAPIER = RAPIER
        this.resources = { ...newResources, ...this.resources }

        this.terrain = new Terrain()
        this.physics = new Physics()
        this.wireframe = new PhysicsWireframe()
        this.physicalVehicle = new PhysicsVehicle()
        this.zones = new Zones()
        this.territory = new Territory()
        this.territoryFence = new TerritoryFence()
        this.player = new Player()
        this.character = new Character()
        this.closingManager = new ClosingManager()
        this.interactivePoints = new InteractivePoints()
        this.konamiCode = new KonamiCode()
        this.achievements = new Achievements()
        this.train = new Train()
        this.tornado = new Tornado()
        this.map = new Map()
        this.title = new Title()
        // this.monitoring = new Monitoring()
        this.world.step(1)
        this.overlay = new Overlay()

        // Pre-render if quality high
        if(this.quality.level === 0 && this.rendering.renderer.backend.isWebGPUBackend)
            PreRenderer.render()

        this.ticker.wait(3, () =>
        {
            this.reveal.updateStep(0)
        })

        // Debug achievement
        if(this.debug.active)
        {
            this.achievements.setProgress('debug', 1)
        }

        // === 火车站台 InteractivePoint ===
        const stationPose = this.train.trackPath.getPoseAt(0)
        // 站台放在铁轨外侧（tangent 的 side 方向），离铁轨 2m
        const stationPosition = stationPose.position.clone()
        stationPosition.y += 0.5
        {
            const up = new THREE.Vector3(0, 1, 0)
            const side = new THREE.Vector3().crossVectors(stationPose.tangent, up).normalize()
            stationPosition.add(side.multiplyScalar(2))
        }

        this.trainBoarded = false
        this.trainBoardedInteractHandler = null
        this.trainStationPoint = this.interactivePoints.create(
            stationPosition,
            'Train Station — 按 E 上车',
            InteractivePoints.ALIGN_LEFT,
            InteractivePoints.STATE_CONCEALED,
            () =>
            {
                this.trainBoardToggle()
            }
        )
    }

    trainBoardToggle()
    {
        if(!this.trainBoarded)
        {
            // === 上车 ===
            this.trainBoarded = true

            // 停掉物理车辆控制
            this.physicalVehicle.deactivate()
            this.player.state = Player.STATE_LOCKED
            this.character.active = false
            this.character.object3D.visible = false

            // Camera 挂到火车座舱
            this.train.attachCamera(this.view.camera)

            // 火车启动
            this.train.setRunning(true)

            // 隐藏站台 InteractivePoint
            this.trainStationPoint.hide()

            // 注册全局 E 键监听（绕过 InteractivePoints 距离检查），按一下就下车
            this.trainBoardedInteractHandler = () =>
            {
                if(this.trainBoarded)
                    this.trainBoardToggle()
            }
            this.inputs.events.on('interact', this.trainBoardedInteractHandler)
            this.inputs.interactiveButtons.events.on('interact', this.trainBoardedInteractHandler)

            this.notifications.show(/* html */`
                <div class="top"><div class="title">🚆 上车！</div></div>
                <div class="bottom"><div class="description">火车开始绕岛一圈 · 按 E 下车</div></div>
            `, '', 3)
        }
        else
        {
            // === 下车 ===
            this.trainBoarded = false

            // 解绑下车监听
            if(this.trainBoardedInteractHandler)
            {
                this.inputs.events.off('interact', this.trainBoardedInteractHandler)
                this.inputs.interactiveButtons.events.off('interact', this.trainBoardedInteractHandler)
                this.trainBoardedInteractHandler = null
            }

            // Camera 恢复
            this.train.detachCamera(this.view.camera)

            // 火车停车
            this.train.setRunning(false)

            // 恢复物理车辆控制
            this.physicalVehicle.activate()
            this.player.state = Player.STATE_DEFAULT

            // 恢复车辆位置到当前位置（火车停处）的轨道边
            const exitPose = this.train.trackPath.getPoseAt(this.train.t)
            const exitPos = exitPose.position.clone()
            exitPos.y += 0.5
            {
                const up = new THREE.Vector3(0, 1, 0)
                const side = new THREE.Vector3().crossVectors(exitPose.tangent, up).normalize()
                exitPos.add(side.multiplyScalar(3))
            }
            this.physicalVehicle.moveTo(exitPos, Math.atan2(exitPose.tangent.x, exitPose.tangent.z))

            // 恢复站台交互
            this.trainStationPoint.state = InteractivePoints.STATE_CONCEALED
            this.trainStationPoint.intersect.active = true

            this.notifications.show(/* html */`
                <div class="top"><div class="title">🚆 下车</div></div>
                <div class="bottom"><div class="description">已回到你的车</div></div>
            `, '', 2)
        }
    }

    reset()
    {
        // Interactive buttons
        this.inputs.interactiveButtons.clearItems()

        // Player respawn
        this.player.respawn(null, () =>
        {
            // Objects reset
            this.objects.resetAll()

            // Explosive crates
            if(this.world.explosiveCrates)
                this.world.explosiveCrates.reset()

            // Bowling
            if(this.world.areas.bowling)
                this.world.areas.bowling.restart()

            // Cookie
            if(this.world.areas.cookie)
                this.world.areas.cookie.cookies.instancedGroup.needsUpdate = true

            // Toilet
            if(this.world.areas.toilet)
                this.world.areas.toilet.cabin.down = false

            // Social
            if(this.world.areas.social)
            {
                this.world.areas.social.statue.down = false
                this.world.areas.social.fans.instancedGroup.needsUpdate = true
            }
            
            // Benches
            if(this.world.benches)
                this.world.benches.instancedGroup.needsUpdate = true
            
            // Fences
            if(this.world.fences)
                this.world.fences.instancedGroup.needsUpdate = true
            
            // Bricks
            if(this.world.bricks)
                this.world.bricks.instancedGroup.needsUpdate = true
            
            // Lanterns
            if(this.world.lanterns)
                this.world.lanterns.instancedGroup.needsUpdate = true

            // Achievement
            gsap.delayedCall(2, () =>
            {
                this.achievements.setProgress('reset', 1)
            })
        })
    }
}

