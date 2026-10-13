import { Game } from './Game.js'

/**
 * 玩家领地（纯数据，不产生任何视觉呈现）
 *
 * 边界 = 玩家在游戏地图上手绘的那条线（车辆图标只是当时的位置参照，不参与计算）。
 * 地图像素经 12 个地点销钉标定后换算到世界坐标（Map.worldToMap，terrain.size = 192），
 * 得到一条南北走向的直线：
 *   x ≈ -37.2，z 从 -36.3（北端）到 -16.2（南端）
 *
 * 领地取该线以西。
 */
export class Territory
{
    constructor()
    {
        this.game = Game.getInstance()

        // 手绘边界线（世界坐标，北 → 南两个端点）
        this.boundary = [
            { x: - 37.2, z: - 36.3 },
            { x: - 37.2, z: - 16.2 },
        ]

        // 领地范围：以该线为东边界
        this.bounds = {
            minX: - 96,
            maxX: - 37.2,
            minZ: - 96,
            maxZ: - 16.2,
        }
    }

    contains(_x, _z)
    {
        return (
            _x >= this.bounds.minX && _x <= this.bounds.maxX &&
            _z >= this.bounds.minZ && _z <= this.bounds.maxZ
        )
    }
}