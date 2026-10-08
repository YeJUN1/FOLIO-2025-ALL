import { Events } from './Events.js'

export class Viewport
{
    constructor(domElement)
    {
        this.domElement = domElement

        this.events = new Events()

        // 运行时自适应像素比上限（由 Rendering.setAdaptiveResolution 控制，null = 未干预）
        this.pixelRatioAdaptive = null

        this.measure()
        this.setResize()
    }

    measure()
    {
        const bounding = this.domElement.getBoundingClientRect()

        this.width = bounding.width
        this.height = bounding.height
        this.ratio = this.width / this.height

        this.pixelRatioPure = window.devicePixelRatio
        this.pixelRatioMax = 1.5
        this.applyPixelRatio()
    }

    applyPixelRatio()
    {
        let pixelRatio = Math.min(this.pixelRatioPure, this.pixelRatioMax)

        if(this.pixelRatioAdaptive !== null)
            pixelRatio = Math.min(pixelRatio, this.pixelRatioAdaptive)

        this.pixelRatio = pixelRatio
    }

    setResize()
    {
        const throttleDuration = 400
        let throttleTimeout = null
        addEventListener('resize', () =>
        {
            this.measure()
            this.events.trigger('change')

            if(throttleTimeout)
            {
                clearTimeout(throttleTimeout)
            }

            throttleTimeout = setTimeout(() =>
            {
                throttleTimeout = null
                this.events.trigger('throttleChange')
            }, throttleDuration)
        })
    }
}