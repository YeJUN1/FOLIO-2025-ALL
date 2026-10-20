import * as THREE from 'three/webgpu'
import { color, float, Fn, sin, texture, time, uv, vec4 } from 'three/tsl'
import { Game } from '../Game.js'

/**
 * 四块地盘的占领光墙。从高处能同时看见整张地图被圈住。
 */
export class TerritoryClaim
{
    constructor()
    {
        this.game = Game.getInstance()

        this.group = new THREE.Group()
        this.group.name = 'territoryClaim'
        this.game.scene.add(this.group)

        this.colors = [ '#ff2bd6', '#ffd000', '#3dfff2', '#fff4c8' ]
        this.build()
    }

    makeMaterial(_hex, _alpha, _intensity, _phase)
    {
        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        })

        const tint = color(_hex)
        material.outputNode = Fn(() =>
        {
            const pulse = float(0.78).add(sin(time.mul(2.2).add(_phase)).mul(0.22))
            return vec4(tint.mul(_intensity).mul(pulse), float(_alpha))
        })()

        return material
    }

    addBox(_material, _width, _height, _depth, _x, _y, _z)
    {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(_width, _height, _depth), _material)
        mesh.position.set(_x, _y, _z)
        mesh.frustumCulled = false
        mesh.castShadow = false
        mesh.receiveShadow = false
        this.group.add(mesh)
    }

    build()
    {
        const plots = this.game.territory.plots
        const wallHeight = 16

        plots.forEach((plot, index) =>
        {
            const hex = this.colors[index % this.colors.length]
            const wall = this.makeMaterial(hex, 0.72, 2.4, index * 1.3)
            const pillar = this.makeMaterial(hex, 1, 4.5, index * 0.7)

            const width = plot.maxX - plot.minX
            const depth = plot.maxZ - plot.minZ
            const centerX = (plot.minX + plot.maxX) * 0.5
            const centerZ = (plot.minZ + plot.maxZ) * 0.5
            const thickness = 0.85

            this.addBox(wall, width, wallHeight, thickness, centerX, wallHeight * 0.5, plot.minZ)
            this.addBox(wall, width, wallHeight, thickness, centerX, wallHeight * 0.5, plot.maxZ)
            this.addBox(wall, thickness, wallHeight, depth, plot.minX, wallHeight * 0.5, centerZ)
            this.addBox(wall, thickness, wallHeight, depth, plot.maxX, wallHeight * 0.5, centerZ)

            const corners = [
                [ plot.minX, plot.minZ ],
                [ plot.maxX, plot.minZ ],
                [ plot.maxX, plot.maxZ ],
                [ plot.minX, plot.maxZ ],
            ]

            for(const [ x, z ] of corners)
                this.addBox(pillar, 2.2, 36, 2.2, x, 18, z)
        })

        this.addTitle()
    }

    addTitle()
    {
        const canvas = document.createElement('canvas')
        canvas.width = 2048
        canvas.height = 640
        const context = canvas.getContext('2d')
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = '#ffffff'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.font = '900 280px Nunito, sans-serif'
        context.fillText('全是我的', canvas.width * 0.5, 230)
        context.font = '700 110px Nunito, sans-serif'
        context.fillText('PETERZHANG', canvas.width * 0.5, 470)

        const map = new THREE.CanvasTexture(canvas)
        map.colorSpace = THREE.SRGBColorSpace
        map.needsUpdate = true

        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        })
        material.outputNode = Fn(() =>
        {
            const sample = texture(map, uv())
            const pulse = float(0.85).add(sin(time.mul(1.6)).mul(0.15))
            return vec4(sample.rgb.mul(3.2).mul(pulse), sample.a)
        })()

        const title = new THREE.Mesh(new THREE.PlaneGeometry(78, 24), material)
        title.position.set(0, 42, 0)
        title.rotation.y = Math.PI * 0.25
        title.frustumCulled = false
        this.group.add(title)
    }
}
