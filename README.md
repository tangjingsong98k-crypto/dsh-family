# dsh-family-kit —— 家人电脑上的 DSH（远程可维护 + 数据镜像）

一套把「本机 DSH 的版本与插件」复刻到另一台不在同一局域网的 Windows 电脑，
并且能远程升级、远程装插件、远程排障的东西；顺带把汐汐记的**收支**和**饮食**
同步过去，家人打开 DSH 的「生活」面板（或双击一个网页）就能看到最新统计。

```
   本机（这台）                                   家人电脑
 ┌──────────────────────────────┐            ┌──────────────────────────────┐
 │ C:\custom\dsh\family-kit     │            │ C:\custom\dsh\family-kit     │
 │                              │            │                              │
 │  publish.mjs（每 2 分钟）     │            │  agent.mjs（每 2 分钟）       │
 │   ├ 账本 ledger.json ────────┼──┐      ┌──┼──> git pull（版本/插件/数据）│
 │   ├ 饮食 diet.db → diet.json ┼──┤      │  │   ├> 版本不对 → npm install  │
 │   └ 统计 latest.json/index.html│ │      │  │   ├> 插件清单变 → pnpm install │
 │                              │  │      │  │   ├> 进程没了 → 拉起来        │
 │  fam.mjs（运维台）            │  ▼      │  │   └> 写 status/<主机>.json    │
 │   status / version / plugin  │ 私有 Git 仓库（GitHub private）           │
 │   logs / shell / restart     │ <───────┼── status + ops 结果推回来        │
 └──────────────────────────────┘            └──────────────────────────────┘
                                                        │
                                              双击 打开 DSH.url → Web 界面
                                              （生活面板：收支 + 饮食，只读）
```

三条链路各自独立，坏一条不影响另外两条：

| 链路 | 方向 | 载体 | 断了会怎样 |
|---|---|---|---|
| 版本 / 插件 / 配置 | 本机 → 家人 | `mirror.json` + `plugins/` | 家人电脑保持最后一版，照常能用 |
| 数据（收支 + 饮食 + 统计页） | 本机 → 家人 | `data/` | 面板停在上次同步的数字 |
| 状态 / 远程指令 | 双向 | `status/`、`ops/` | 本机看不到家人电脑的新状态，指令排队 |

---

## 1. 目录里都是什么

```
family-kit\
  mirror.json               ← 唯一事实源：DSH 版本、插件清单、端口、看谁的饮食
  install.cmd               ← 家人电脑第一次装：双击它
  start.cmd / stop.cmd      ← 装好后生成（写死本机 node 路径）
  打开 DSH.url               ← 装好后生成（带 token 的登录链接，双击即开）
  profile\cordis.patch.yml.tpl   ← profile 补丁层模板（只读账本 + 饮食快照 + 默认模型）
  plugins\dsh-balance\      ← 生活面板插件（本机开发目录的镜像，含只读快照支持）
  tools\
    install.mjs             ← 首次安装：凭据、启动器、装配、计划任务、拉起
    apply.mjs               ← 把 mirror.json 落到机器上（钉版本 + pnpm + 补丁层）
    agent.mjs               ← 家人电脑每 2 分钟收敛一次（拉取/应用/看进程/跑指令/报状态）
    server.mjs start.mjs    ← DSH 进程启停 + 抓登录 token
    safety.mjs              ← 启动验证 / 自动回滚 / 安全模式（防插件或版本把人挡在门外）
    publish.mjs             ← 本机发布器：账本 + 饮食快照 + 统计页 + 插件源码
    stats.mjs               ← 统计口径与 HTML 渲染
    diet-dump.py            ← 在 AstrBot 容器里跑，只读 diet.db 导快照
    fam.mjs                 ← 本机远程运维台
    tasks.mjs               ← 计划任务（XML 定义，不弹黑窗）
    get-node.ps1            ← 机器上没有 Node 24 时下便携版
    run-hidden.vbs          ← 计划任务用它隐藏窗口
    common.mjs              ← 公共件（路径、git、日志、端口）
  data\                     ← 同步给家人的数据（本机发布，家人只读）
    balance\ledger.json     ← 账本镜像
    diet\diet.json          ← 饮食快照（容器 diet.db 的导出）
    stats\latest.json       ← 预计算统计
    stats\index.html        ← 双击就能看的统计页（离线可用）
  status\                   ← 家人电脑上报的状态 + 远程指令的执行结果
  ops\                      ← 本机排队的远程指令（家人执行完挪进 ops\done）
  runtime\                  ← 装出来的东西（git 忽略）：app（DSH 本体）、home（DSH_HOME）、logs…
```

两台机器上的路径故意一模一样（`C:\custom\dsh\family-kit`），
所以远程说「打开 logs\agent.log」时不用先问「你那边在哪」。

---

## 2. 首次部署

### 2.1 本机：建一个私有仓库当「中转站」

家人电脑和本机不在一个局域网，谁也不该开公网端口。两边都能**主动访问**的
地方只有 Git 托管，所以拿一个私有仓库当信箱：本机往里推，家人电脑从里拉。

1. GitHub 上新建**私有**空仓库，名字随意（下面用 `dsh-family-kit`），
   **不要**勾选自动生成 README。
2. 建一个 **fine-grained PAT**（Settings → Developer settings → Fine-grained tokens）：
   - Repository access：**Only select repositories** → 只勾 `dsh-family-kit`；
   - Permissions → Repository permissions → **Contents: Read and write**；
   - 有效期按需（90 天 / 1 年），到期换掉重打包即可。
3. 把仓库绑上（HTTPS + token 的写法两台机器都能直接用）：

   ```powershell
   cd C:\custom\dsh\family-kit
   node tools\fam.mjs remote "https://<你的GitHub用户名>:<PAT>@github.com/<用户名>/dsh-family-kit.git"
   ```

   （仓库已经 init 过、有一个初始提交；第一次只需要 `remote` 这一步。）
   `remote` 绑远端并推第一版。本机已经绑到
   `git@github.com:tangjingsong98k-crypto/dsh-family.git`，这步不用再跑。
   不想把 token 写进 URL 也行：先 `git remote add origin <url>`，靠 Git Credential Manager
   记住凭据——但家人电脑那边仍要在 `config.local.json` 里有可用的远端地址。

> 安全边界：PAT 只勾这一个仓库 + 只给 Contents 读写，泄露的影响就是「这个仓库被人读写」。
> 别选 All repositories，也别把 PAT 贴进任何会提交的文件（`config.local.json` 已在 `.gitignore` 里）。

### 2.2 本机：先发一次数据、装上发布任务

```powershell
cd C:\custom\dsh\family-kit
node tools\fam.mjs data                    # 立刻发一次：账本 + 饮食 + 统计页
node tools\fam.mjs install-publish-task    # 之后每 2 分钟自动发一次
```

`fam.mjs data` 会打印这轮发了多少：

```
发布完成：账本 18 笔，饮食 1 人，本月支出 ¥1015.60，今日摄入 0 kcal
git：已提交并推送
```

数据来源在 `publisher.json`（首次运行自动生成，可改）：

```json
{
  "ledger": "C:\\custom\\workzone\\balance\\ledger.json",
  "balancePlugin": "C:\\custom\\workzone\\playground\\dsh-balance",
  "diet": {
    "docker": "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    "container": "astrbot",
    "pluginDir": "/AstrBot/data/plugins/astrbot_plugin_diet_log"
  }
}
```

### 2.3 本机：打包

```powershell
node tools\fam.mjs pack
# 已打包：C:\custom\dsh\family-kit\dist\dsh-family-kit-2026-11-26-19-10-00.zip（取自远端仓库）
```

包里已经带好：`config.local.json`（远端地址 + DeepSeek API key）、插件源码、模板，
以及一把**只属于这个仓库的 deploy key**（`secrets\deploy\id_ed25519`）。
把 zip 拷到家人电脑（U 盘 / 网盘 / QQ 都行）。

> 第一次打包前，把这把 key 的公钥加到仓库，否则家人电脑拉不动：
> GitHub 仓库 → Settings → Deploy keys → Add deploy key →
> 标题随意，Key 粘贴 `secrets\deploy\id_ed25519.pub` 的内容 → **勾选 Allow write access**。
> 加完再 `pack`。家人电脑的 git 会自动用包里这把钥匙（`config.local.json` 的 `sshKey`），
> 不登录 GitHub、也不碰你自己的 SSH key。

> 想换一个 API key：改 `config.local.json` 的 `apiKey`，重新 `pack` 一次
> （或者直接在家人电脑 DSH 的「设置」里换）。

### 2.4 家人电脑：解压 + 双击

1. 把 zip 解压到 **`C:\custom\dsh\`**，得到 `C:\custom\dsh\family-kit`（建议就用这个路径，文档和远程指令都按它写）。
2. 双击 `install.cmd`。它会：
   - 找 Node 24；没有就下便携版到 `runtime\node`（不需要管理员）；
   - 把 DeepSeek API key 写进 `runtime\home\.credentials.yaml`；
   - `npm install @deepseek-ai/dsh@<mirror.json 里的版本>`（第一次几分钟，看网速）；
   - 生成 profile（`dsh-balance` + `dsh-plugin-health` + `dsh-context` + `dsh-whale-widget`）；
   - 用本机的快照渲染一份自己的统计页（`打开统计.url`，看的是这台设备选的 QQ）；
   - 装两个计划任务（登录时 + 每 2 分钟）；
   - 起 DSH，打印带 token 的登录链接。
3. 装完双击目录里的 **`打开 DSH.url`** 就能进界面；以后开机自动起，链接会随重启刷新。

装完的样子：

```
==============================================
 装好了。
 DSH 版本 : 0.2.2-rc.2
 运行状态 : 在跑
 登录链接 : http://127.0.0.1:38090/?token=...
 双击入口 : C:\custom\dsh\family-kit\打开 DSH.url
 数据目录 : C:\custom\dsh\family-kit\data
 之后每两分钟自动同步一次；改了 mirror.json 推上去就行。
==============================================
```

### 2.5 国内网络（可选但建议看一眼）

`mirror.json` 默认把 npm 源设成 `https://registry.npmmirror.com`，装不上会自动退回
`https://registry.npmjs.org`。另外 `apply.mjs` 给 npm 子进程加了
`NODE_OPTIONS=--dns-result-order=ipv4first`：这台机器实测过 IPv6 只连不通数据，
npm 会连上一堆 IPv6 socket 然后停十几分钟不动；强制 IPv4 优先后同样的安装一两分钟就完。

### 2.6 验证

本机：

```powershell
node tools\fam.mjs status
```

看到类似（第一轮最多等两分钟）：

```
== FAMILY-PC ==
  检查时间   2026-11-26T19:12:03.441Z
  DSH 版本   0.2.2-rc.2（清单要求 0.2.2-rc.2）
  运行状态   在跑，HTTP 200，pid 12345
  登录链接   http://127.0.0.1:38090/?token=...
  数据时间   2026-11-26T19:10:00.000Z
  账本/饮食  18 笔 / 1044949250
  仓库       a1b2c3d；已是最新
```

家人电脑：DSH 右栏空状态里点「生活」，或会话标题栏右侧的日历按钮；
账本和饮食都是**只读**的——点「记下」会提示去 QQ 找汐汐。

---

## 3. 日常：本机怎么远程维护

所有命令在 `C:\custom\dsh\family-kit` 下跑。

### 3.1 看状态

```powershell
node tools\fam.mjs status
```

`status\` 里每台家人电脑一个 JSON（`status/<主机名>.json`），内容就是上面那些字段，
外加最近的应用记录、错误、日志尾巴。

状态不是每轮都提交：内容没变就不写（否则仓库每两分钟多一个提交），
但每 30 分钟会强制刷一次心跳。所以 `检查时间` 最多可能差半小时；
要立刻确认它还活着，用 `node tools\fam.mjs diagnose`（会真的去那台机器上跑一遍）。

### 3.2 远程升级 DSH

```powershell
node tools\fam.mjs version 0.2.2-rc.5
```

改 `mirror.json` → 提交推送 → 家人电脑下一轮 `npm install` 新版本 → 重启 → 状态里
`DSH 版本` 变成新的。装失败会留在旧版本，`errors` 里带 npm 的最后几行。
回滚就是再 `version` 回旧号。

> 本机是源码检出跑 rc.2，和家人的 npm 版同号但不同来源；要「版本镜像」就把两边
> 的号对齐（`version` 改成你本机正在跑的号即可）。

### 3.3 远程装 / 关插件

`mirror.json` 的 `plugins` 是唯一入口，改完推上去就生效：

```powershell
node tools\fam.mjs plugin dshmarket on      # 打开插件市场
node tools\fam.mjs plugin dsh-bili-eyes on  # 打开 B 站插件
```

要装清单里没有的新插件：在 `mirror.json` 的 `plugins` 里加一条（`spec` 写 npm 版本或
`link:{{KIT}}/plugins/<目录>`），把源码放进 `plugins/<目录>`，然后：

```powershell
node tools\fam.mjs push
```

家人电脑下一轮会 `pnpm install` 并重启一次 DSH。

### 3.4 远程排障

```powershell
node tools\fam.mjs diagnose                 # 版本、node/npm、端口、pid、登录链接
node tools\fam.mjs logs --lines 80          # agent/apply 日志尾巴
node tools\fam.mjs shell "Get-Process node | Select-Object Id,StartTime"
node tools\fam.mjs restart                  # 重启 DSH
node tools\fam.mjs ops                      # 看历史指令结果
```

`logs` / `shell` 会等结果（最多 4 分钟，通常一轮 2 分钟内回来）。返回的是家人电脑上
的真实输出，`shell` 走 PowerShell，120 秒超时，输出截到 8000 字。

### 3.5 立刻重发数据

```powershell
node tools\fam.mjs data
```

平时不用管：本机的 `DSHFamilyPublish` 任务每 2 分钟跑一次 `publish.mjs`。

### 3.6 多台设备（同一套件、同一个仓库）

同一个仓库可以挂任意多台：每台都从 `pack` 出来的包安装，`agent.mjs` 各跑各的，
计划任务名一样但属于各自机器，互不影响。

- **状态**：`status/<主机名>.json` 每台一份，`fam.mjs status` 一次列全。
- **指令定向**：`fam.mjs diagnose --to FAMILY-PC` 只让那台执行；不带 `--to` 则是
  所有机器都执行（广播）；`--to *` 同广播。不是自己的指令会留在 `ops/` 里等目标来取。
- **每台的本地配置**：`config.local.json`（不提交）里放 `remote`、`apiKey`、`dietQq`——
  同一份代码在不同机器上可以有不同的人、不同的 key。
- **统计页**：每台设备用本地快照按自己的 `dietQq` 渲染 `data/stats/local.html`；
  仓库里的 `index.html` 只是默认那个 QQ 的公共副本。
- **写冲突**：只有主电脑写 `data/`，家人电脑只读（插件层禁写 + agent 以远端为准）；
  `status/` 每台只写自己的文件，推送失败会 `pull --rebase` 后重试。
- **远端凭据**：每台的 `pack` 包里带着同一个 PAT，等于每台都能读写这个仓库；
  哪台不用了，把它的 `config.local.json` 删掉或换 PAT 即可。

### 3.7 防坏：启动验证、自动回滚、安全模式

给不会用电脑的人维护，最怕的是「改完打不开了」。这一层是自动的，不用他做任何事：

1. **先存好使的**：每次启动成功（HTTP 200/401）后，把 profile 的
   `package.json` / `cordis.yml` / `cordis.patch.yml` / `pnpm-workspace.yaml` 和当前
   DSH 版本存进 `runtime/last-good/`。
2. **改完必须真的起来**：改版本或插件后，agent 起服务并等 `mirror.json` 里
   `safety.bootTimeoutSec`（默认 75 秒）；这期间没有应答就算失败。
3. **失败就回滚**：把 `last-good` 的四个文件写回去、必要时装回上个版本、重启、再等一次。
   成功则写 `runtime/hold.json`：同一个配置指纹不再重试（不会每两分钟重启循环），
   状态里 `held: true`。
4. **还起不来就进安全模式**：profile 只剩 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，
   第三方插件一个不加载，保证界面能打开；状态里 `safeMode: true`。

主电脑这边：

```powershell
node tools\fam.mjs status              # 会显示：安全模式 / 已冻结 / 上次好使 / 连续失败
node tools\fam.mjs rollback            # 人工回滚到上次好使的配置
node tools\fam.mjs safe-mode on        # 强制进安全模式（怀疑某个插件时）
node tools\fam.mjs safe-mode off       # 退出安全模式，按 mirror.json 重新装回来
node tools\fam.mjs apply               # 清掉 hold，强制再试一次当前配置
```

配置在 `mirror.json`：

```json
"safety": { "bootTimeoutSec": 75, "autoRollback": true }
```

回滚/安全模式都是**本机状态**，不会污染仓库；主电脑下一次改 `mirror.json`
（指纹变了）会自动解除冻结，重新尝试新配置。

### 3.8 换版本的稳妥顺序（给朋友那台）

1. 先在本机或一台测试机上装同版本（`tools/fam.mjs smoke` 没做，用 `install.cmd --no-tasks` 到一个空目录即可）；
2. `fam.mjs version <新版本>` → 等他那台 status 里 `dshVersion` 变过来；
3. 打开看一眼生活面板；
4. 有问题 `fam.mjs rollback`，两分钟内回到上一版。

### 3.9 金丝雀：先在第二实例上试，通过了才装

`tools/canary.mjs` 在 `runtime/canary/` 里养了一个**完全独立的第二实例**：自己的
`app`（独立 node_modules）、自己的 `home`（独立 DSH_HOME）、自己的端口（默认在用端口 +1）。
agent 每轮先算「这轮要不要改」：

```
计划有变化？
  ├─ 没有 → 什么都不做
  └─ 有 → 金丝雀：装目标版本 → 装同一份 profile → --dump-config → 起一次 → 等应答
           ├─ 通过 → 才 apply() 到正在用的那份 → 重启 → 再验证（失败还有回滚兜底）
           └─ 失败 → 冻结（hold），正在用的那份一个字节都没动，status 写明失败在哪一步
```

配置：

```json
"canary": { "enabled": true, "port": 38091, "timeoutSec": 120 }
```

- 第一次跑金丝雀要下目标版本（约 1 分钟、多占约 700MB 磁盘）；之后同一版本只跑启动验证；
- 想跳过（比如机器空间紧张）：`"enabled": false`；
- 手动跑一次：`node tools\fam.mjs canary`（排队给那台执行，返回 JSON）；
- `fam.mjs status` 里的 `金丝雀` 一行就是最近一次结果（通过/失败、版本、失败阶段、原因）。

---

### 3.10 生活面板上的「同步」按钮

面板底部多了一个 **同步**（`同步中…`）：点一下立刻执行 profile 里配的 `syncCommand`，跑完自动重读数据。

- 家人电脑：`syncCommand: 'node <kit>/tools/sync-now.mjs'` —— 立刻 `git pull`（带冲突自救），不用等下一个周期；
- 主电脑：`syncCommand: 'node <kit>/tools/publish.mjs'` —— 立刻发布账本/饮食/统计并推送；
- 记账或删账成功后，面板会弹一条「已保存。要立刻同步到其他机器吗？」：**立刻同步** / **等自动同步**；
- 命令由 profile 配置写死，浏览器只能触发、不能传命令；没配时接口明确报「这台设备没配同步命令」。

---

## 4. 数据是怎么到家人电脑上的

### 4.1 收支

```
QQ 里跟汐汐说「今天午饭 25」
  → AstrBot 的 dsh-balance 侧账本：C:\custom\workzone\balance\ledger.json
  → publish.mjs 原样搬到 data\balance\ledger.json（校验坏了就保留上一份）
  → git push
  → 家人电脑 agent 拉下来
  → 他的 dsh-balance 面板 root 指向 data\balance，刷新就是新数字
```

### 4.2 饮食

```
QQ 里跟汐汐说「早上两个包子一杯豆浆」
  → 容器里 diet.db（AstrBot 的 astrbot_plugin_diet_log）
  → publish.mjs 在容器里跑 diet-dump.py（sqlite mode=ro）导成 data\diet\diet.json
  → 家人电脑的插件用「快照模式」读这份 JSON（没有 docker 也能看）
```

快照里的字段和容器接口 `scripts/panel_api.py` 的 `day/month/year` 完全同形，
所以面板代码没改，只是数据源从「docker exec」换成了「读文件」。
口径：`clock` 是记录时的容器本地时间；月/年的人均按「有记录的日子」算。

### 4.3 看谁的饮食（每台设备各自选）

`mirror.json` 的 `data.dietQq` 只是**仓库级默认值**；每台设备可以用自己的
`config.local.json` 里的 `dietQq` 覆盖它（`apply.mjs` 渲染补丁层时设备本地优先）。
`fam.mjs pack --qq <QQ>` 就是把这一项写进包里。

所以「其他人怎么拉自己的数据」= 同一个仓库、同一份账本，**每台设备各自指向自己的 QQ**：

```powershell
# 给 1044949250 那台打包
node tools\fam.mjs pack --qq 1044949250

# 给 99132013 那台打包
node tools\fam.mjs pack --qq 99132013
```

安装/每轮收敛时，`apply.mjs` 会用这台设备选中的 QQ 在本地渲染
`data\stats\local.html`（双击 `打开统计.url`），所以统计页和面板看到的是同一个人；
仓库里那份 `data\stats\index.html` 只是「默认那个 QQ」的公共副本。

两条前提：

1. **家人的 QQ 必须在 AstrBot 的白名单里**（`platform_settings.id_whitelist`，
   `qq-napcat:FriendMessage:<QQ>`），否则汐汐根本不理他，也就没有可同步的记录；
2. 那个 QQ 要在 `mirror.json` 的 `data.dietUsers` 里（导出范围），改完 `node tools\fam.mjs push`。

现在这份库的 `dietUsers` 只有 `1044949250`，而他还没有任何记录，所以家人电脑的饮食卡片
先是空的、统计页会写「这个 QQ 还没记过饭」——这是对的，等他哪天在 QQ 里跟汐汐说
「早上吃了两个包子」，下一轮同步就有数字了。

> 传输边界：同一个分支上的 `data/diet/diet.json` 里放着 `dietUsers` 里所有人的记录，
> 每台设备都会把整份文件拉下来，只是面板显示选中的那一个。要让「谁的数据只到谁家」
> 变成传输隔离，就得改成每人一个数据分支（`data/<QQ>`）或每人一个仓库——
> `apply.mjs`/`publish.mjs` 的导出逻辑是现成的，多一层分支即可，没有做进默认流程。

`data.dietUsers` 是导出范围：默认只导出 `1044949250`，主人的饮食记录**不会**发到
家人电脑（想一起同步就把 `99132013` 也加进去）。

### 4.4 统计页

`data\stats\index.html` 是给「不想开 DSH 只想瞄一眼」的场景准备的：
双击就开，样式内联、离线可用，内容是本日/本月的收支与摄入、最近 14 天表格、
本月支出分类。它和 DSH 面板读同一份数据，数字一定一致。

### 4.5 只读是故意的

家人电脑上 `cordis.patch.yml` 把插件配成 `readOnly: true` + `dietSnapshot: ...`：

- 账本：`save` / `remove` 直接抛「这是只读镜像」；
- 饮食：只允许 `day/month/year` 查询，写操作一律拒绝；
- 面板的「看谁」下拉框只列 `data/diet/diet.json` 里导出的人，切换只是换着看，改不了。
- 原因：真实记录只有 QQ 里汐汐那一份。两边都能写的话，下一次 `git pull` 就会把
  家人刚记的东西覆盖掉——那不是同步，是丢数据。

要变成「家人也能记」，正确做法不是解开只读，而是让他的记录也进同一个账本
（例如让汐汐在群里替他记），再同步回来。

---

### 4.6 数据多久能到（每台机器各自拉）

每台机器都是同一个仓库的独立克隆，机器之间没有实时连接，仓库就是总线。一次更新要过四段：

| 段 | 谁 | 现在多久 | 在哪调 |
| --- | --- | --- | --- |
| 1. 记录 → 落盘 | 汐汐写 diet.db / ledger.json | 即时 | — |
| 2. 发布（落盘 → git push） | 主电脑 `DSHFamilyPublish` | 1 分钟 | 计划任务 `/MO 1` |
| 3. 拉取（git pull → 本地文件） | 对方机器 `DSHFamilyAgent` | 1 分钟 | `mirror.json` 的 `agent.intervalMinutes` |
| 4. 面板读到新文件 | 生活面板 | ≤30 秒（切人时立即） | 插件里 30 秒静默同步 |

所以**最坏约 2.5 分钟，典型 1 分钟左右**。每轮只拉增量（git），一次几百字节到几十 KB。

想更快：

- 改 `mirror.json` 的 `agent.intervalMinutes`，再 `node tools\fam.mjs reschedule`，那台会把计划任务重建成新周期（不用重装）；
- 本机发布也可以改成事件驱动（`publish.mjs --watch`：账本或饮食一变就推），延迟压到秒级；
- 真要「秒级、实时」只能上一条常连接：Tailscale/WireGuard 组网，让主电脑直接 POST 给每台机器的本地接收端（或用 `ssh -R` 反向隧道）——
  公网 NAT 下对方无法被主动连接，Git 轮询就是零基础设施下的上限。

机器离线时：面板继续显示上次拉到的数据（只读快照），下次开机第一轮自动补上；
不会出现「本地有一份旧数据被当成新数据」——agent 每轮以远端为准。

### 4.7 冲突怎么处理

`git pull --rebase` 撞车时不再只是记一行日志，按「数据能合就合、代码别乱合」处理：

| 文件 | 规则 |
| --- | --- |
| `data/balance/ledger.json` | 按 `id` 并集；同一条取 `updatedAt` 更新的 |
| `data/diet/diet.json` | 取 `exportedAt` 更新的那份 |
| `data/stats/**`、`status/**` | 取上游（rebase 的 `:2`，都是派生物/本机回执） |
| 其他（`tools/`、`mirror.json`、`plugins/`…） | **不猜** |

数据全合上了就 `rebase --continue`，继续推送；只要还剩代码/配置冲突，就 `rebase --abort`
（不留半截），把情况写进 `runtime/conflict.json`，然后开一个 **headless 会话初判**：

- 能按事实解决的（看 git log、看两侧取值），会话直接改文件并 commit，日志里写明依据；
- 涉及**事实性矛盾**的（同一笔账两个金额、同一个人的体重两个值），不许猜：写进
  `runtime/conflict-questions.md`，`fam.mjs status` 会把这些行原样列出来（最多 6 行），等你拍板。

关掉自动会话：`mirror.json` 里 `"conflict": { "autoSession": false }`，冲突就只留报告。

自测：`node tools/test-conflict.mjs` —— 两个场景（纯数据冲突自动合、代码冲突 abort + 报告）都跑真 git。

## 5. 常见问题

**家人电脑第一次 `npm install` 很慢 / 卡住**
`mirror.json` 里把 `dsh.npmRegistry` 设成国内镜像再重装：

```json
"npmRegistry": "https://registry.npmmirror.com"
```

**GitHub 连不上**
`install.cmd` 里那步 `npm install` 需要 npm 源，`agent.mjs` 的拉取需要 GitHub。
两个都不通的话，退化成「U 盘更新」：本机 `fam.mjs pack`，覆盖家人电脑的
`plugins\`、`data\`、`profile\`，然后 `fam.mjs shell "..."` 不可用，让家人双击
`start.cmd` 重启一次即可。

**打开 DSH 是 401 / 要 token**
双击 `打开 DSH.url`（每次启动都会刷新）。链接在 `runtime\login-url.txt` 里也有一份。

**端口 38090 被占**
改 `mirror.json` 的 `dsh.port`，`push`；家人电脑下一轮会换端口重启，
`打开 DSH.url` 跟着更新。

**面板里点「记下」没反应 / 提示只读**
正常的，见 4.5。

**他那台打不开了 / 界面空白**
先 `fam.mjs status` 看两个字段：
`safeMode: true` ＝ 已经自动降级成官方 bundle（界面能开，第三方插件没加载），
用 `fam.mjs logs` 看是谁的问题，修好后 `fam.mjs safe-mode off`；
`held: true` ＝ 上次改动启动失败、已自动回滚到上次好使的配置，
`fam.mjs rollback` 可手动再回滚一次，`fam.mjs apply` 会清掉冻结、按当前
`mirror.json` 再试一遍。两种情况都不需要他动手。

**`fam.mjs status` 里一直是旧的**
按顺序查三段：本机 `DSHFamilyPublish` 任务在不在跑（`schtasks /Query /TN DSHFamilyPublish`）→
`git log --oneline -3` 有没有新提交、`git push` 成不成功 → 家人电脑 agent 有没有拉
（`status` 里的 `repo.sync` 和 `checkedAt`）。

**API key 换了**
改 `config.local.json` 的 `apiKey`，重新 `pack` 到家人电脑装一次；
或者直接在家人电脑 DSH 的「设置」里换。

---

## 5.1 端口与入口速查

| 东西 | 在哪 |
|---|---|
| 家人电脑 DSH Web | `http://127.0.0.1:38090/?token=...`（只监听回环，token 每轮启动刷新） |
| 登录链接文件 | `runtime\login-url.txt`、`打开 DSH.url` |
| 账本镜像 | `data\balance\ledger.json` |
| 饮食快照 | `data\diet\diet.json` |
| 统计页 | `data\stats\index.html`（仓库默认那个 QQ）、`data\stats\local.html`（本机选的 QQ，`打开统计.url`） |
| 状态回执 | `status\<主机名>.json`、`status\ops\<指令id>.json` |
| 远程指令队列 | `ops\*.json`（执行完挪进 `ops\done\`） |
| 计划任务 | `DSHFamilyAgent`（每 2 分钟）、`DSHFamilyLogon`（登录时）、`DSHFamilyPublish`（本机，每 2 分钟） |
| 日志 | `logs\agent.log`、`logs\apply.log`、`logs\publish.log`、`logs\dsh-*.log` |

---

## 6. 可选：直接看家人电脑的界面（Tailscale + SSH）

Git 那条链路够运维（改版本、装插件、跑命令、看日志），但看不到画面。
要像坐在那台电脑前一样，加一层私有网络：

1. 两台机器都装 [Tailscale](https://tailscale.com/download)（Windows 版，管理员装一次），
   登录同一个 tailnet。装完 `tailscale status` 能看到对方。
2. 家人电脑装 OpenSSH 服务端（管理员 PowerShell）：

   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Set-Service sshd -StartupType Automatic
   Start-Service sshd
   ```

3. 本机连过去，把 DSH 的端口借过来：

   ```powershell
   ssh -L 38090:127.0.0.1:38090 <家人电脑用户名>@<tailscale 里的机器名>
   ```

   然后浏览器开 `http://127.0.0.1:38090/?token=...`（token 在
   `C:\custom\dsh\family-kit\runtime\login-url.txt`，也可以
   `ssh ... "type C:\custom\dsh\family-kit\runtime\login-url.txt"` 取）。

DSH 仍然只监听 `127.0.0.1`，公网和局域网都摸不到；Tailscale 只是把两台机器放进
同一个虚拟内网，SSH 再把端口隧道过来。

---

## 7. 设计取舍（为什么不是别的做法）

- **为什么用 Git 而不是远程桌面/端口映射**：两边都在 NAT 后面，最省事的中转是双方
  都能主动访问的仓库；顺带拿到版本历史、回滚、状态回执，不需要公网端口、不需要
  一直开着本机。
- **为什么用计划任务轮询而不是常驻服务**：家人电脑会睡眠、会断网、会关机；
  「每两分钟醒一次、干完就退」比常驻进程抗折腾，也不需要守护进程。
- **为什么插件只读**：数据只有一份真实来源（QQ 里的汐汐）。镜像端写 = 覆盖 = 丢数据。
- **为什么 DSH 钉在 `runtime\app` 而不是全局 npm**：全局装要管理员，而且升级会把
  唯一的实例弄坏；独立目录可以整棵替换、装坏了还能从 `runtime\app` 删了重装。
- **为什么路径写死 `C:\custom\dsh\family-kit`**：远程排障时少一轮「你那边在哪」；
  `KIT_ROOT` 其实是从脚本位置推的，真换路径也能跑，只是文档与命令按固定路径写。
