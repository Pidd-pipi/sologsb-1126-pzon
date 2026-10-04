# 露营营地选址评估器（gbcampsite）

面向营地规划者与户外领队：把候选营位的地形、补给与隐患折算成综合得分。地图选点登记营位，录入坡度、水源距离、风向、信号等因子，配置权重后实时重排名次并给出 A/B/C 等级。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21826>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21826 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`siteStore` / `profileStore` / `uiStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`），未配置时自动降级为本地 SVG 网格视图 |
| 本地数据 | IndexedDB（Dexie，`gbcampsite-db`，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Campsite 营位 | `frontend/src/types/campsite.ts` | 营位编号、名称、所属营地、经纬度、海拔、坡度、坡向、地表类型、可容帐篷数、平整度评分、进出方式、默认方案 |
| FactorAssessment 因子评估 | `frontend/src/types/factor.ts` | 所属营位、水源距离、风向与风力等级、信号强度、日照时长、落石落枝风险、植被遮蔽度、离车距离、离步道距离、评估人、评估日期 |
| ScoreProfile 权重方案 | `frontend/src/types/score.ts` | 方案名、各因子权重（0-100）、归一化方式（极差归一 / 阈值分段）、A/B/C 等级阈值、适用季节、是否启用 |
| RiskVeto 风险否决项 | `frontend/src/types/veto.ts` | 营位 id、否决类型（河道内 / 山洪沟 / 孤树下 / 崖底落石区 / 陡坡）、说明、判定人、判定日期 |
| OccupancyBatch 入住批次 | `frontend/src/types/ledger.ts` | 批次号（幂等键）、营地、意向营位、入住日、帐篷数、状态（预占 / 已确认 / 排队 / 待重算 / 旧入住 / 已释放）、携带的营地版本、窗口标识、预占到期时间 |
| CampMeta 营地容量版本 | `frontend/src/types/ledger.ts` | 营地名称（主键）、容量版本号、最近变更时间 |

### 容量台账（并发占用规则）

营地容量做成「带日期的占用账本」，解决值班室两个窗口同时放最后一间帐篷位的并发问题：

- **两成应急余量**：按营地 + 入住日，`可分配容量 = 可用容量 × 80%`（可用容量 = 物理容量 − 被否决营位容量），余量只多不少；
- **排队**：剩余不足的批次按提交时间 FIFO 排队，腾出名额自动递进，队首放不下不跳过；
- **幂等**：批次号重复提交只生效一次；
- **营地版本乐观锁**：登记携带营地版本，旧窗口保存时若容量 / 因子 / 否决已变化导致版本递增，拒绝写入、保留表单并提示重新确认，不覆盖新容量；
- **失效重算**：容量、营位因子或风险否决变化后，相关批次立即置为「待重算」，确认前不占容量、不进入营位名次与地图；
- **预占到期 / 失联释放**：临时预占（hold）带 TTL 与心跳，窗口关闭（pagehide）或到期自动释放；
- **旧入住待确认**：没有容量批次的历史入住列为「旧入住·待确认」，不挤占剩余名额，补登后才占用容量。

### IndexedDB 版本与升级迁移

库名 `gbcampsite-db`（Dexie），共 6 张表：`sites`、`factors`、`profiles`、`vetos`、`batches`、`campMeta`。

- **v1**：建立 `sites`（营位）与 `factors`（因子评估）两张表。
- **v2**：新增 `profiles`（权重方案）表，并为 `factors` 补 `siteId` 索引，让「按营位取因子」走索引；同时为存量因子补齐 `shade`、`distanceToCar`、`distanceToTrail` 缺省值。
- **v3**：新增 `vetos`（风险否决）表，并为存量营位回填 `defaultProfileId`（取当前启用方案的 id）与新增字段缺省值。
- **v4**：新增 `batches`（入住批次，`batchNo` 唯一索引）与 `campMeta`（营地容量版本）两张表；为存量营地补容量版本元数据，并把开台账前的纸质 / 口头入住补为「旧入住·待确认」批次（不占容量）。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 营位名次表（按综合得分降序，展示坡度、水源距离、信号与等级，可按营地/地表/进出方式筛选，命中否决项整行标红） | Campsite、FactorAssessment、RiskVeto |
| `/sites/new` | 新增营位（地图点选或手填经纬度，录入海拔、坡度、坡向与容量，支持草稿保存） | Campsite、FactorAssessment |
| `/sites/:id` | 营位详情（上部地图定位与基本信息，中部因子打分表，下部否决记录与多轮复核） | 四个模型 |
| `/scoring` | 权重与评分（拖动各因子权重条，名次实时刷新，可另存为季节方案） | ScoreProfile、Campsite |
| `/map` | 营位地图（高德 JS API 标记按等级着色，未配置 `VITE_AMAP_KEY` 时退化为本地 SVG 网格视图） | Campsite、RiskVeto |
| `/veto` | 风险否决登记（选营位与否决类型、填说明，提交后名次表与地图同步更新） | RiskVeto、Campsite |
| `/ledger` | 容量台账（按营地 + 入住日测算容量、两成应急余量、批次预占 / 确认 / 排队 / 待重算 / 旧入住补登，预占到期与失联自动释放） | OccupancyBatch、CampMeta、Campsite、RiskVeto |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `MapPanel.vue`（高德 + SVG 网格双模式）、`FactorScoreBar.vue`（原始值 / 归一化得分 / 权重占比）、`GradeBadge.vue`（A/B/C 等级与得分气泡）、`EmptyState.vue`（空态与新建入口）、`WeightEditor.vue`（权重条编辑器）
- hooks：`frontend/src/hooks/useAmapLoader.ts`（按需注入高德 JS API，key 缺省或加载失败返回降级标记）、`useRanking.ts`（归一化得分与名次）、`useLocalDraft.ts`（表单草稿）
- utils：`frontend/src/utils/score.ts`（极差归一、阈值分段、加权求和、等级阈值、否决短路）、`geo.ts`（经纬度距离与网格坐标换算）、`format.ts`（数值与日期格式化、流水编号）、`db.ts`（Dexie 封装与样例数据）、`draft.ts`（localStorage 草稿）

## 六、地图降级说明

`VITE_AMAP_KEY` 为空时，`useAmapLoader()` **不会**请求 `webapi.amap.com`，而是立即返回降级标记；
`MapPanel` 随即渲染本地 SVG 网格视图（可点选、可查看详情），因此**构建与运行都不依赖该 key**。
若配置了 key，则注入脚本时带 `onerror` 与 8 秒超时双兜底，失败同样降级，不会产生 console error。

## 七、目录结构

```
sologsb-1126/
├── docker-compose.yml
├── .env / .env.example
├── README.md
└── frontend/
    ├── Dockerfile            # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{campsite,factor,score,veto,ledger}.ts
        ├── stores/{siteStore,profileStore,uiStore,ledgerStore}.ts
        ├── components/common/{MapPanel,FactorScoreBar,GradeBadge,EmptyState,WeightEditor}.vue
        ├── hooks/{useAmapLoader,useRanking,useLocalDraft}.ts
        ├── pages/{Ranking,SiteNew,SiteDetail,Scoring,MapView,Veto,Ledger}.vue
        ├── router/index.ts
        ├── utils/{score,geo,format,db,draft,ledger}.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- 全部数据只存在浏览器本地：营位、因子评估、权重方案、否决记录存 **IndexedDB**（Dexie，库名 `gbcampsite-db`）。
- 表单草稿（新增营位、否决登记）存 **localStorage**，键前缀 `gbcampsite:draft:`，刷新或误关页面后可恢复。
- 容器完全无状态：不使用数据库服务、不挂载命名卷，清除浏览器站点数据即回到首次运行的样例营地。
