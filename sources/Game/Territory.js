import { Game } from './Game.js'

/**
 * 玩家领地。主仓里原先分属各位同学的地块，现在全部归 peterzhang。
 * contains() 落在任一块内即为自己的地盘。
 * bounds 仍是西北石栏那一块，TerritoryFence 按这块摆。
 */
export class Territory
{
    constructor()
    {
        this.game = Game.getInstance()
        this.owner = 'peterzhang'

        this.plots = [
            { name: 'peterzhang', minX: - 96, maxX: - 37.2, minZ: - 96, maxZ: - 16.2 },
            { name: 'peterzhang', minX: 18.6, maxX: 95.1, minZ: 26.3, maxZ: 94.4 },
            { name: 'peterzhang', minX: 16, maxX: 86, minZ: - 37, maxZ: 27.4 },
            { name: 'peterzhang', minX: - 6.5, maxX: 46.5, minZ: - 73.3, maxZ: - 40.3 },
            { name: 'peterzhang', minX: - 96, maxX: - 33.5, minZ: - 33, maxZ: 16 },
            { name: 'peterzhang', minX: - 42, maxX: 10, minZ: - 8, maxZ: 22 },
        ]

        this.boundary = [
            { x: - 37.2, z: - 36.3 },
            { x: - 37.2, z: - 16.2 },
        ]
        this.bounds = this.plots[0]

        // Login accounts are mapped to the plot they own.
        // Spawn is either an existing respawn name (guaranteed on solid ground)
        // or an explicit position picked inside a fenced plot that has no respawn.
        this.members = new Map([
            [ '舒雯',   { plot: 0, spawnName: 'timeMachine' } ],
            [ '须翊恒', { plot: 1, spawnName: 'landing' } ],
            [ '唐一琳', { plot: 2, spawnName: 'behindTheScene' } ],
            [ '丁浩宸', { plot: 3, spawn: { x: 15, z: - 60, rotation: 0 } } ],
            [ '龚浩翔', { plot: 4, spawn: { x: - 60, z: - 5, rotation: 0 } } ],
            [ '叶老师', { plot: 5, spawnName: 'circuit' } ],
        ])

        this.aliases = new Map([
            [ 'elim', '唐一琳' ],
            [ 'tanglilin', '唐一琳' ],
        ])
    }

    contains(_x, _z)
    {
        return this.plots.some(plot =>
            _x >= plot.minX && _x <= plot.maxX &&
            _z >= plot.minZ && _z <= plot.maxZ
        )
    }

    getMember(_name)
    {
        if(typeof _name !== 'string')
            return null

        const trimmed = _name.trim()
        const key = trimmed.toLowerCase()
        const resolved = this.aliases.get(key) || trimmed
        const member = this.members.get(resolved)

        if(!member)
            return null

        return {
            name: resolved,
            plot: this.plots[member.plot],
            spawnName: member.spawnName || null,
            spawn: member.spawn || null,
        }
    }
}
