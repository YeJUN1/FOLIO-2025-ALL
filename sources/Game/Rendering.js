import * as THREE from 'three/webgpu'
import { pass, mrt, output, emissive, renderOutput, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { Game } from './Game.js'
import { cheapDOF } from './Passes/cheapDOF.js'
import { Inspector } from 'three/addons/inspector/Inspector.js'

export class Rendering
{
    constructor()
    {
        this.game = Game.getInstance()

        if(this.game.debug.active)
        {
            this.debugPanel = this.game.debug.panel.addFolder({
                title: '📸 Rendering',
                expanded: false,
            })
        }
    }

    start()
    {
        this.setStats()
        this.setAdaptiveResolution()

        this.game.ticker.events.on('tick', () =>
        {
            this.render()
        }, 998)

        this.game.viewport.events.on('change', () =>
        {
            this.resize()
        })
    }

    async setRenderer()
    {
        this.renderer = new THREE.WebGPURenderer({
            canvas: this.game.canvasElement,
            powerPreference: 'high-performance',
            forceWebGL: false,
            antialias: this.game.viewport.pixelRatio < 2
        })
        this.renderer.setSize(this.game.viewport.width, this.game.viewport.height)
        this.renderer.setPixelRatio(this.game.viewport.pixelRatio)
        this.renderer.sortObjects = false

        this.renderer.domElement.classList.add('experience')
        this.renderer.shadowMap.enabled = true
        // this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
        this.renderer.setOpaqueSort((a, b) =>
        {
            return a.renderOrder - b.renderOrder
        })
        this.renderer.setTransparentSort((a, b) =>
        {
            return a.renderOrder - b.renderOrder
        })

        if(location.hash.match(/inspector/i))
        {
            this.renderer.inspector = new Inspector()
        }

        // Make the renderer control the ticker
        this.renderer.setAnimationLoop((elapsedTime) => { this.game.ticker.update(elapsedTime) })

        return this.renderer
            .init()
    }

    setPostprocessing()
    {
        this.postProcessing = new THREE.RenderPipeline(this.renderer)

        const scenePass = pass(this.game.scene, this.game.view.camera)
        const scenePassColor = scenePass.getTextureNode('output')

        this.bloomPass = bloom(scenePassColor)
        this.bloomPass._nMips = this.game.quality.level === 0 ? 5 : 2
        this.bloomPass.threshold.value = 1
        this.bloomPass.strength.value = 0.25
        this.bloomPass.smoothWidth.value = 1

        this.cheapDOFPass = cheapDOF(renderOutput(scenePass))

        // Quality
        const qualityChange = (level) =>
        {
            if(level === 0)
            {
                this.postProcessing.outputNode = this.cheapDOFPass.add(this.bloomPass)
            }
            else if(level === 1)
            {
                this.postProcessing.outputNode = scenePassColor.add(this.bloomPass)
            }

            this.postProcessing.needsUpdate = true
        }
        qualityChange(this.game.quality.level)
        this.game.quality.events.on('change', qualityChange)

        // Debug
        if(this.game.debug.active)
        {
            const bloomPanel = this.debugPanel.addFolder({
                title: 'bloom',
                expanded: false,
            })

            bloomPanel.addBinding(this.bloomPass.threshold, 'value', { label: 'threshold', min: 0, max: 2, step: 0.01 })
            bloomPanel.addBinding(this.bloomPass.strength, 'value', { label: 'strength', min: 0, max: 3, step: 0.01 })
            bloomPanel.addBinding(this.bloomPass.radius, 'value', { label: 'radius', min: 0, max: 1, step: 0.01 })
            bloomPanel.addBinding(this.bloomPass.smoothWidth, 'value', { label: 'smoothWidth', min: 0, max: 1, step: 0.01 })

            const blurPanel = this.debugPanel.addFolder({
                title: 'blur',
                expanded: true,
            })

            blurPanel.addBinding(this.cheapDOFPass.start, 'value', { label: 'start', min: 0, max: 0.5, step: 0.001 })
            blurPanel.addBinding(this.cheapDOFPass.end, 'value', { label: 'end', min: 0, max: 0.5, step: 0.001 })
            // blurPanel.addBinding(this.cheapDOFPass.size, 'value', { label: 'size', min: 1, max: 5, step: 1 })
            // blurPanel.addBinding(this.cheapDOFPass.separation, 'value', { label: 'separation', min: 0, max: 5, step: 0.001 })
            blurPanel.addBinding(this.cheapDOFPass.repeats, 'value', { label: 'repeats', min: 1, max: 100, step: 1 })
            blurPanel.addBinding(this.cheapDOFPass.amount, 'value', { label: 'amount', min: 0, max: 0.02, step: 0.0001 })
        }
    }

    setStats()
    {
        if(!location.hash.match(/stats/i))
            return
            
        this.stats = {}
        this.stats.feed = {}
        this.stats.update = () =>
        {
            this.stats.feed.drawCalls = this.renderer.info.render.drawCalls.toLocaleString()
            this.stats.feed.triangles = this.renderer.info.render.triangles.toLocaleString()
            this.stats.feed.geometries = this.renderer.info.memory.geometries.toLocaleString()
            this.stats.feed.textures = this.renderer.info.memory.textures.toLocaleString()
        }

        this.stats.update()

        // Debug
        if(this.game.debug.active)
        {
             const debugPanel = this.debugPanel.addFolder({
                title: 'Stats',
                expanded: true,
            })

            for(const feedName in this.stats.feed)
            {
                debugPanel.addBinding(this.stats.feed, feedName, { readonly: true })
            }
        }
    }

    resize()
    {
        this.renderer.setSize(this.game.viewport.width, this.game.viewport.height)
        this.renderer.setPixelRatio(this.game.viewport.pixelRatio)
    }

    setAdaptiveResolution()
    {
        // 帧率自适应分辨率：平均帧时长超过 1/45s（<45fps）时逐级下调像素比（步进 0.25，
        // 下限 1），回升至平稳（>57fps）后逐级恢复；每次调整后 3 秒冷却防振荡。
        // 用途：外接高分屏 / 性能波动时自动保流畅；稳定 60fps 时永不触发。
        this.adaptiveLastChange = 0

        this.game.ticker.events.on('tick', () =>
        {
            const elapsed = this.game.ticker.elapsedScaled

            // 启动加载阶段帧率不稳定，跳过；冷却期内不重复调整
            if(elapsed < 15 || elapsed - this.adaptiveLastChange < 3)
                return

            const viewport = this.game.viewport
            const current = viewport.pixelRatioAdaptive === null ? viewport.pixelRatioMax : viewport.pixelRatioAdaptive
            const deltaAverage = this.game.ticker.deltaAverage

            if(deltaAverage > 1 / 45 && current > 1)
                viewport.pixelRatioAdaptive = Math.max(1, current - 0.25)
            else if(deltaAverage < 1 / 57 && current < viewport.pixelRatioMax)
                viewport.pixelRatioAdaptive = Math.min(viewport.pixelRatioMax, current + 0.25)
            else
                return

            this.adaptiveLastChange = elapsed
            viewport.applyPixelRatio()
            viewport.events.trigger('change')
        }, 999)
    }

    async render()
    {
        // this.renderer.render(this.game.scene, this.game.view.camera)
        this.postProcessing.render()

        if(this.stats)
            this.stats.update()

        if(this.game.monitoring?.stats)
        {
            this.game.rendering.renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
            this.game.monitoring.stats.update()
        }
    }
}