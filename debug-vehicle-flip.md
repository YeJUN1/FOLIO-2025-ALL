# Debug Session: vehicle-flip

- **Status**: [OPEN]
- **Issue**: 游戏中的黑色跑车（revuelto.glb）会翻倒成四轮朝天，且不会自动回正
- **Debug Server**: `http://127.0.0.1:7777/event`（见 `.dbg/vehicle-flip.env`）
- **Log File**: `.dbg/trae-debug-log-vehicle-flip.ndjson`
- **RunId**: `pre` → 修复后 `post`

## 环境

- 项目：`c:\Users\Natalie2015\Desktop\FOLIO-2025-ALL`
- 启动：`npm run dev`（Vite，`http://localhost:5173/`）
- 渲染后端：已临时改为 `forceWebGL: true`（`sources/Game/Rendering.js:44`），因 WebGPU 后端在本环境黑屏
- 物理：Rapier3D ray-cast vehicle controller
- 对照基线：`git diff d8b095b 4802c67`（车辆整合提交）

## Reproduction Steps

1. 打开 `http://localhost:5173/`
2. 等待资源加载完成（大模型较慢），点击开始进入游戏
3. 观察黑色跑车的姿态（出生 / 掉落后 / 加速时）
4. **驾驶时**重点观察：起步加速、转向、压过路面高差与路边物件时是否翻倒

> 注：调试用的自动驾驶补丁（`#region debug-point D:auto-drive`）**已移除**（用户反馈"车自己一直动"）。现在需**手动驾驶**复现：起步、加速、直行约 7m（出生点正前方）观察是否还翻。

## 已知静态线索（来自代码检查）

- `4802c67` 换车后改了底盘碰撞体与车轮：Main `[1.32,0.29,0.60]` @ y=-0.58，COM y=-0.88；车轮 offset x=0.8430 z=0.5166，radius=0.2068（原 `[1.3,0.4,0.85]` @ y=-0.1 / COM -0.5；offset x=0.90 z=0.75，radius 0.4）
- 未改动的旧车数值：`engineForceAmplitude=300`、`suspensionsHeights` 0.88/1.23/1.63、`suspensionsStiffness` 20/30/40、`flip.force=5`、`topSpeed=5`/`topSpeedBoost=40`
- `Physics.js:176-177` 的语义：`setMassProperties(mass, centerOfMass, {1,1,1}, ...)` 会把 `centerOfMass` **叠加**到 collider 的 `position` 上（运行时已证实，见下）
- 质量属性：Main 是唯一有质量的碰撞体（2.5kg）；Top/Bumper 质量为 0 但**仍参与碰撞**
- GLB 全节点仅含 translation（无 rotation/scale）→ "重父级导致视觉翻转"假设已排除
- 转动惯量被硬编码为 `{x:1,y:1,z:1}`（Physics.js:177，原车同样如此，非本次回归）

## Hypotheses & Verification

| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 落地冲击翻转（y=4 自由落体落地反弹翻滚） | High | Low | **Rejected** — 502 采样全程 `upY=1`、`angvel≈0`，出生后平稳落地 |
| B | 悬挂几何不匹配导致静止/自行倾覆 | High | Low | **Rejected** — 静止 350s+ 稳定，`contacts=4`，悬挂 0.676/0.676/0.701/0.701 |
| C | 与场景物件互穿被掀翻（出生点） | Med | Low | **Rejected** — 出生点干净落地并静止 |
| D | 加速力过大后翻（wheelie） | Med | Low | **Rejected** — 行驶中翻车时 `upY` 先掉到 0.85 再翻转，无抬头后仰过程；且翻车瞬间 `contacts` 由 4→0（离地） |
| E | 自动复位失效（翻倒后不回正） | High | Low | **Rejected（非根因）** — 复位逻辑正常触发（`upsideDown detected` ×3、`flip jump applied` ×1） |
| **F** | **底盘/Bumper 碰撞体过低**：碰撞盒底面落在/低于轮地接触面（Main 底 ≈ 地面，Bumper 底 ≈ 地下 0.08m），原车台面离地 0.4~0.6m。车身实体随地形刮擦，遇高差/路缘被"撬翻" | **High** | Med | **Confirmed** — 详见下方 Log Evidence |
| G | 质心过低：`localCom.y=-1.46`（≈地面下 0.59m），而原车 ≈ 地面上 0.48m。力矩放大倾覆 | Med | Med | Confirmed（协同因素）—— 与 F 同源，均为碰撞体 y 过低所致 |
| H | 模型枢轴错位：`revuelto.glb` 的 `chassis` 节点无 y 位移（`default.glb` 有 +0.907），整车车身几何体（y≈-0.97~-0.31）落在原点下方，而物理刚体原点在悬挂连接点高度 → 车身视觉下陷进地面 | High | Low | **Confirmed** — GLB 节点解析，见下 |

## Log Evidence

**runId=pre（502 条采样，t=4.85 → 819.54，共约 13 分钟，车始终未被驾驶）**

- `chassis mass properties`：`{"mass":2.5,"localCom":{"x":0.05,"y":-1.46,"z":0},"principalInertia":{"x":1,"y":1,"z":1}}`
  - 证实 `Physics.js:177` 的 `centerOfMass` 叠加语义：`-0.58 + (-0.88) = -1.46`
- `vehicle moved/spawned`：`pos=[39.529, 4, 37.825]`
- 采样统计：`upY min=max=1`（从未倾斜）、`posY 0.621..3.973`、`angvelMag max 0.59`、`contacts ∈ {0,4}`
- 静止平衡自校验：底盘 y=0.870 → Main 碰撞体底 = `0.870-0.58-0.29 = 0.0`（贴地）；Bumper 底 = `0.870-0.6177-0.33 = -0.078`（**陷入地面**）；轮底 = `0.870-(0.676+0.2068) = -0.013`
- 无 `upsideDown detected`、无 `flip jump applied`、**无任何 `acc != 0`**

**结论（静止阶段）**：A/B/C 被运行时证据证伪；车在静止与自由落体下完全稳定。翻倒必发生在**驾驶**过程中。

**runId=pre（驾驶阶段，3 次页面加载 + 自动驾驶补丁）**

- **车身碰撞极其频繁**：`chassis body collision` 事件 **830+ 条**，力直方图 `{0-5:674, 5-20:143, 20-50:4, 50-100:5, 100+:4}`，最大 **200+**
- **静止也碰撞**：车在出生点静止（`pos=[39.53,0.87,37.84]`、`spd=0.01`、`contacts=4`）时，车身碰撞仍以 ~2.4N **持续发生** → 车身碰撞盒与地形长期接触
- **热点区**：`x,z≈(38,41)` 共 190 次碰撞、最大力 165 —— 出生点附近存在高差/台阶被车身反复顶撞
- **翻车点固定**：两次翻车都发生在 `pos≈[46.0, 1.3, 40.8]`（出生点正前方约 7m），过程为「四轮着地(contacts=4)行驶 → 突然 `angvel≈6.5 rad/s` 剧烈翻滚、`spd` 6.5→12、离地(contacts=0) → 四轮朝天」，即**车身底部撞上地形高差后被撬起翻滚**
- `upsideDown detected` ×3（upY 0.25/0.35/0.31）、`flip jump applied` ×1

## Fix Applied（最小修复）

**根因（git diff `d8b095b`→`4802c67` 决定性证据）**：换小号跑车模型时，底盘碰撞盒被整体下移，而车轮半径同步缩小（0.4→0.2068，轮底恰好触地）——两者改动不同步，导致**碰撞盒底面低于轮底**：

| 碰撞体 | 修改前 (4802c67) | 修复后 |
|--------|------------------|--------|
| Main pos.y / COM.y | -0.58 / -0.88 | **-0.10 / -0.50** |
| Top pos.y | -0.40 | **0.40** |
| Bumper pos.y | -0.6177 | **-0.20** |

- 形状尺寸（`parameters`）保持新模型适配值不变；车轮参数（radius 0.2068 等）自校验正确（轮底 ≈ 0.000），**不改**
- 效果：Main 底 0.0→**0.48**、Bumper 底 -0.078→**0.34**（恢复离地间隙）；质心 world -0.59→**+0.27**（回到地面上）
- 同时**移除**自动驾驶补丁（region D），遥测 `runId` 切为 `post`

## Fix Applied 2（车身视觉下陷）

**根因（假设 H，GLB 节点解析）**：

| 模型 | `chassis` 根节点 y 位移 | 车身网格 y 范围（模型空间） | 轮胎中心 y / 半径 |
|------|------------------------|---------------------------|------------------|
| `default.glb` | **+0.907** | [0.395, 1.760]（原点上方） | -0.4172 / ~0.42 |
| `revuelto.glb` | **无（null）** | [-0.970, -0.310]（原点下方） | -0.7876 / 0.2075 |

- `chassis` 与 `wheelContainer` 在两模型中均为**根级兄弟节点**（非父子），故车轮不受车身偏移影响
- `revuelto` 模型设计意图：原点在 地面 + 0.995（轮胎底 -0.995 触地）；**PhysicsVehicle** 静止时把原点放在 地面 + 0.835（悬挂连接点，实测悬挂长 ≈0.623、轮半径 0.2068）
- 两者相差 **0.16** → 车身视觉整体下陷 ≈0.10m 进地面（原碰撞盒修复后又多陷 3.5cm，因原先入地的 Bumper 盒在顶车）

**修复**：在 [VisualVehicle.js](file:///c:/Users/Natalie2015/Desktop/FOLIO-2025-ALL/sources/Game/World/VisualVehicle.js) 的 `setParts()` 中（`setWheels()` 之前），把 `parts.chassis.children`（车身网格 + 灯光）整体 `position.y += 0.16`。纯视觉补偿，**不改任何物理参数**（避免影响已调好的防翻车手感）。

## Verification Conclusion

[待填充：post-fix 复测 —— 需用户手动驾驶到出生点正前方约 7m 处，确认不再翻车；预期 `chassis body collision` 次数与最大力大幅下降]