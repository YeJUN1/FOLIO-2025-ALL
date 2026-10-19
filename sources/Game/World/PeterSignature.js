import * as THREE from 'three/webgpu'
import { color, texture, uv, vec4 } from 'three/tsl'
import { Game } from '../Game.js'
import { MeshDefaultMaterial } from '../Materials/MeshDefaultMaterial.js'

/**
 * 出生点西侧的名牌。纯视觉，不参与碰撞。
 * 面向东，对着 landing 出生点，开车离开须翊恒那一侧就能看见。
 */
export class PeterSignature
{
    constructor(description)
    {
        this.game = Game.getInstance()
        this.description = description

        this.group = new THREE.Group()
        this.group.name = 'peterDomainSignature'

        const position = description.position || { x: 11, z: 36 }
        const groundY = this.getGroundElevation(position.x, position.z)
        const minY = this.game.water.surfaceElevation + 0.05
        this.group.position.set(position.x, Math.max(groundY, minY), position.z)
        this.group.rotation.y = description.rotationY ?? Math.PI / 2

        this.game.scene.add(this.group)
        this.setFrame()
        this.setPlaque()
    }

    setFrame()
    {
        const material = new THREE.MeshBasicNodeMaterial()
        material.userData.prevent = true
        const revealed = MeshDefaultMaterial.revealDiscardNodeBuilder(this.game, color('#3a2418'))
        material.outputNode = vec4(revealed, 1)

        const posts = [
            { x: -4.35, y: 1.7 },
            { x: 4.35, y: 1.7 },
        ]

        for(const post of posts)
        {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.5, 0.18), material)
            mesh.position.set(post.x, post.y, 0)
            mesh.castShadow = true
            mesh.receiveShadow = true
            this.group.add(mesh)
        }

        const bar = new THREE.Mesh(new THREE.BoxGeometry(8.9, 0.16, 0.16), material)
        bar.position.set(0, 3.46, 0)
        bar.castShadow = true
        this.group.add(bar)
    }

    setPlaque()
    {
        const canvas = document.createElement('canvas')
        canvas.width = 1024
        canvas.height = 420
        const context = canvas.getContext('2d')

        context.clearRect(0, 0, canvas.width, canvas.height)
        this.fillRoundRect(context, 16, 16, canvas.width - 32, canvas.height - 32, 28, '#1b1214')
        context.lineWidth = 10
        context.strokeStyle = '#e6b35a'
        this.strokeRoundRect(context, 36, 36, canvas.width - 72, canvas.height - 72, 18)

        context.textAlign = 'center'
        context.fillStyle = '#e6b35a'
        context.font = '700 40px Nunito, sans-serif'
        context.fillText(this.description.kicker || "FREE LAND", canvas.width / 2, 128)

        context.fillStyle = '#fff7ea'
        context.font = '700 108px "Amatic SC", Nunito, sans-serif'
        context.fillText(this.description.title || "PETER'S DOMAIN", canvas.width / 2, 250)

        context.fillStyle = '#f0d7a2'
        context.font = '700 42px Nunito, sans-serif'
        context.fillText(this.description.subtitle || 'peterzhang0528', canvas.width / 2, 328)

        const map = new THREE.CanvasTexture(canvas)
        map.colorSpace = THREE.SRGBColorSpace
        map.needsUpdate = true

        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: true,
        })
        material.userData.prevent = true
        const sampled = texture(map, uv())
        const revealed = MeshDefaultMaterial.revealDiscardNodeBuilder(this.game, sampled)
        material.outputNode = vec4(revealed, sampled.a)

        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8.2, 3.36), material)
        mesh.position.set(0, 2.15, 0.02)
        mesh.castShadow = false
        mesh.receiveShadow = false
        this.group.add(mesh)
    }

    fillRoundRect(context, x, y, width, height, radius, fillStyle)
    {
        context.beginPath()
        context.roundRect(x, y, width, height, radius)
        context.fillStyle = fillStyle
        context.fill()
    }

    strokeRoundRect(context, x, y, width, height, radius)
    {
        context.beginPath()
        context.roundRect(x, y, width, height, radius)
        context.stroke()
    }

    getGroundElevation(_x, _z)
    {
        const startY = 50
        const ray = new this.game.RAPIER.Ray({ x: _x, y: startY, z: _z }, { x: 0, y: - 1, z: 0 })
        const hit = this.game.physics.world.castRay(ray, 100, true)

        return hit ? startY - hit.timeOfImpact : 0
    }

    setVisible(visible)
    {
        this.group.visible = visible
    }
}
