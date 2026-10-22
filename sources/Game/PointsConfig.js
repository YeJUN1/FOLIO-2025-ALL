// 积分与等级的共用配置：Points（计算/展示）与 Achievements（通知 + 列表标注）都要用。
// 单独成文件是为了避免 Points.js 与 Achievements.js 相互 import。

// 每个成就折算多少积分：保底 100，按难度（成就的 total）累计加成。
// 加成有意压缩（上限 300），避免单个大成就一次性顶飞等级条。
export function valueFor(total)
{
    const safeTotal = Number(total)

    if(!Number.isFinite(safeTotal) || safeTotal < 1)
        return 100

    let value = 100

    if(safeTotal >= 4)
        value += 40
    if(safeTotal >= 10)
        value += 60
    if(safeTotal >= 100)
        value += 100

    return value
}

// 等级档位：at = 达到总可得分的比例即解锁；名字沿用全站英文 UI 风格。
// 档位间距逐级加大（6% → 17%）：前期升级快、后期更耐玩。
// Legend 放在 85%，留出余量，不必把包括不可达成项（hacker）在内的所有成就都刷满。
export const TIERS = [
    { name: 'Novice',    at: 0    },
    { name: 'Explorer',  at: 0.06 },
    { name: 'Driver',    at: 0.15 },
    { name: 'Daredevil', at: 0.26 },
    { name: 'Collector', at: 0.39 },
    { name: 'Veteran',   at: 0.53 },
    { name: 'Master',    at: 0.68 },
    { name: 'Legend',    at: 0.85 },
]
