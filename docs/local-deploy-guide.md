# 本地链部署与演示环境搭建指导

> 面向录制演示视频的队员：按本文把 StakeBeast 完整跑在你本机的本地 Hardhat 链上（chainId 31337），含 MetaMask 配置、双人演示钱包准备、时间快进等演示专用技巧。
>
> 通用安装步骤（克隆、四组件安装、常见报错）以根目录 `README.md` 的 **Getting started** 为准——那部分已实测，本文不重复，只在演示需要处引用并补充。Sepolia 部署另有文档（README "Deployment (Sepolia)" 与 `.env.example`），不在本文范围。

## 0. 前置条件

| 项 | 要求 | 检查命令 |
| --- | --- | --- |
| Node.js | ≥ 20.12，**建议 22 LTS**（backend 测试套件要求 ≥ 22） | `node --version` |
| Git | 任意近期版本 | `git --version` |
| MetaMask | 浏览器扩展；双人演示建议两个浏览器（见第 6 节） | — |
| 项目目录 | 短路径、纯 ASCII、**不含 `&` 与中文等非 ASCII 字符**，如 `C:\dev\StakeBeast`（npm 的 Windows shim 在特殊字符路径下会坏） | — |
| 终端 | Windows 推荐 Git Bash；README 中 Git Bash / PowerShell 命令并列处任选其一，同一终端内别混用 | — |

## 1. 克隆与安装（一次性）

按 README **Step 1** 执行：克隆到干净路径，然后在仓库根目录依次安装四个包：

```bash
npm install                    # 根：合约 + 部署/e2e 脚本
npm --prefix attester install  # 证明服务
npm --prefix backend install   # 社交后端
npm --prefix frontend install  # React 前端
```

成功标志：每条命令以 `added N packages` 结束、无 `npm error` 行。`npm warn deprecated` 与 `found N vulnerabilities` 是提示而非失败，**不要**跑 `npm audit fix --force`。遇到的典型报错与解法见 README 排障表（本文第 9 节也汇总了演示向新坑）。

## 2. 全局视图：五个终端 + 账户角色

整套环境需要 **5 个终端窗口**（每个进程一个，全部保持运行）：

| 终端 | 跑什么 | 端口 |
| --- | --- | --- |
| T1 | Hardhat 本地链 | 8545 |
| T2 | 一次性命令（部署、健康检查、时间快进） | — |
| T3 | 证明服务 attester | 3001 |
| T4 | 社交后端 backend | 4000 |
| T5 | 前端 vite dev | 5173 |

本地链 20 个内置账户各预置 10000 ETH。部署脚本（`scripts/deploy.js`）在 localhost 下的默认角色分配（`scripts/role-addresses.js`）：

| Hardhat 账户 | 地址 | 角色 | 是否导入 MetaMask |
| --- | --- | --- | --- |
| #0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 部署者 = 合约 owner（admin 作废演示用它） | 需要（admin 演示） |
| #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | attester 签名账户 | **不要导入**（避免误操作；它的私钥填进 attester/.env） |
| #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | 慈善地址 charity | 建议导入（罚没演示可登录它点 Withdraw 展示善款到账） |
| #3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | 演示用户 A | 需要 |
| #4 | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | 演示用户 B | 双人演示需要 |

演示用户也可改用 #5 及以后账户，只需保持「演示账户 ≠ attester」。

## 3. 启动顺序（严格按序）

### 3.1 T1：启动本地链

```bash
# Git Bash
HARDHAT_MINING_INTERVAL=5000 npx hardhat node
```

```powershell
# PowerShell
$env:HARDHAT_MINING_INTERVAL=5000; npx hardhat node
```

间隔出块（每 5 秒一块）是**必需的**：证明服务的签名门槛要求链上持续有新区块。

预期输出：`Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/`，随后列出 20 个账户及私钥。**这个窗口保持可见**——attester 私钥从 `Account #1` 取。

### 3.2 T2：部署合约

```bash
npx hardhat run scripts/deploy.js --network localhost
```

预期输出：

```
BeastNFT deployed:   0x5FbDB2315678afecb367f032d93F642f64180aa3
StakeBeast deployed: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512   ← 主合约地址
BeastNFT minter -> StakeBeast
Wrote …/deployments/localhost.json
```

地址同时写入 `deployments/localhost.json`（字段 `stakeBeast` / `beastNFT`）。Hardhat 链是确定性的：全新链首次部署的地址通常就是上面两个，但仍以你本次输出为准。

### 3.3 配置三个 .env

只有三个文件需要填真实值，所有值都来自前两步输出。

```bash
# Git Bash
cp attester/.env.example attester/.env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

```powershell
# PowerShell
Copy-Item attester\.env.example attester\.env
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env
```

> ⚠️ **记事本陷阱（Windows）**：用记事本「另存为」建 .env 会被悄悄加成 `.env.txt`，服务启动报缺配置。用 `dir attester` 检查；多了后缀就改回来（详见 README Step 4）。

**`attester/.env` —— 改 2 行，其余保持默认：**

```
CONTRACT_ADDRESS=<3.2 的 StakeBeast deployed 地址>
ATTESTER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

这个私钥是 Hardhat **公开的**内置账户 #1 密钥（也可从 T1 窗口 `Account #1` 抄），只在一次性本地链可用；任何真实网络绝不能用。注意区分：**地址 42 字符（含 0x）是公开标识，私钥 66 字符是机密**——填反了启动即报错（README Step 4 有对照表）。

**`backend/.env` —— 改 1 行：**

```
CONTRACT_ADDRESS=<同上 StakeBeast 地址>
```

（`JWT_SECRET` 等其余项用模板自带的开发默认值即可。）

**`frontend/.env` —— 填 5 行（前端演示必须，README 旧快照里"可选"的说法已过时）：**

```
VITE_CHAIN_ID=31337
VITE_CONTRACT_ADDRESS=<StakeBeast 地址>
VITE_NFT_CONTRACT_ADDRESS=<BeastNFT 地址>
VITE_PROOF_SERVICE_URL=http://localhost:3001
VITE_API_BASE_URL=http://localhost:4000/api
```

`VITE_CHAIN_ID=31337` 让前端把期望网络从 Sepolia 切到本地链；不配它，MetaMask 连上后会一直停在"错误网络"页。

### 3.4 T3 / T4：起两个服务

```bash
npm --prefix attester run dev    # T3
npm --prefix backend run dev     # T4
```

预期输出：

- T3：`[attester] listening on http://localhost:3001 (data: …)`
- T4：`[backend] StakeBeast social backend listening on http://localhost:4000/api`

健康检查（T2 执行）：

```bash
# Git Bash
curl http://localhost:3001/health
curl http://localhost:4000/api/health
```

```powershell
# PowerShell（5.1 里 curl 是别名，输出不是裸 JSON，用下面这个）
Invoke-RestMethod http://localhost:3001/health
Invoke-RestMethod http://localhost:4000/api/health
```

预期：attester 返回 `{"ok":true,"runId":…,"signer":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}`——**signer 必须等于部署输出的 Attester 地址**；backend 返回 `{"ok":true}`。

### 3.5 T5：起前端

```bash
npm --prefix frontend run dev
```

预期输出：Vite 的 `Local: http://localhost:5173/`。浏览器打开该地址。

> 改动 `frontend/.env` 后必须重启 vite（Ctrl+C 再 `npm --prefix frontend run dev`），环境变量只在启动时读取。

## 4. MetaMask 配置（每个演示浏览器各做一次）

1. 打开 `http://localhost:5173`，点 **Connect Wallet**。前端检测到错网会自动弹 `wallet_switchEthereumChain`；MetaMask 里没有本地链时会触发 `wallet_addEthereumChain`，确认添加即可（参数已预填：chainId `31337` / RPC `http://127.0.0.1:8545` / 符号 ETH）。手工添加：MetaMask → 网络 → 添加网络 → 手动，同上三项。
2. **导入测试账户**：MetaMask → 账户菜单 → 导入账户 → 粘贴私钥（从 T1 窗口或第 2 节表格抄）。建议导入 #0（admin）、#3（用户 A）、#4（用户 B）、#2（charity，可选），并改名为 "Admin" / "UserA" / "UserB" / "Charity" 方便录制时辨认。
3. 连上后导航栏右侧显示网络 chip「Local Hardhat」和短地址；余额应为 10000 ETH 左右。

> ⚠️ **本地链重启后必须清 MetaMask 缓存**：Hardhat 链重启会把 nonce 归零，MetaMask 记得旧 nonce，交易会报 `nonce too high` 或直接失败。解法：MetaMask → 设置 → 高级 → **清除活动标签页数据**（Clear activity tab data），对每个导入过的账户生效。这是本地演示最高频的坑。

## 5. 首次闭环演练（约 3 分钟，验证环境正确）

用用户 A（账户 #3）跑一条最短单人专注会话，验证「质押 → 监控 → 签名 → 结算 → 铸兽 → 提现」全链路：

1. 前端 **Create** → 选 Solo Focus → Stake `0.05` ETH、Focus duration `1` 分钟 → **Stake & Create**，MetaMask 确认。
2. 跳转 `/focus/:id` 后点 **Enable focus tracking**——一次 `personal_sign` 钱包签名（无 gas），这是证明服务的绑定握手。
3. 点 **Start session** 发 `startSession` 交易。页面进入监控态：中央兽从**蛋**开始随进度成长（15% 裂蛋 → 40% 孵化 → 65% → 90% 成形），下方倒计时与心跳计数（每 5 秒一次）。
4. 窗口结束后点 **Go to settlement** → **Fetch attestation & settle**：前端向证明服务取 EIP-712 签名（服务侧 425 轮询最多约 30 秒）→ 自动发 `settle`。
5. 绿色结果卡「Beast minted, stake returned」→ **View in My Zoo** 看到刚铸的兽（1 分钟 = Sprout 档）。
6. 回结算页顶部 **Withdrawable balance** → **Withdraw**，0.05 ETH 回到钱包。

任一步与描述不符，先查第 9 节排障表，再回看对应服务的终端日志。

## 6. 双人演示的钱包准备

对赌（Mutual Bet）与共同专注（Co-Focus Duo）需要两个账户同时操作，两种方式：

- **推荐：两个浏览器**（如 Chrome + Edge，或同一浏览器的两个用户配置），各装 MetaMask、各导入一个账户（A=#3、B=#4）。录屏时并排摆放或快速切换窗口，观众能看清"两个人"。
- 备选：单浏览器 MetaMask 内切换账户。前端监听 `accountsChanged`，切账户即刷新数据，不会串号；但两个人来回切观感差，只作兜底。

社交功能（打卡上传、监督人审核列表、昵称头像）需要先在页面里点 **Sign in with wallet** 做一次签名登录（免 gas）；监督人演示前建议给 A、B 都设好昵称，审核列表里显示昵称比短地址直观。

## 7. 演示专用技巧

### 7.1 时间快进（罚没 / 到期路径必需）

默认窗口参数 join / start / grace 都是 **3600 秒**（1 小时）。成功路径不受影响（窗口是自己选的 1–2 分钟）；但「结算宽限期过后罚没归慈善」要等 `endTime + 3600s`，录视频不可能干等。Hardhat 提供 `evm_increaseTime` / `evm_mine` 直接拨快链上时间。

把下面脚本存为 `scripts/dev-timejump.js`（一次性，仓库未内置）：

```js
// 本地链演示专用：拨快链上时间。用法：
//   Git Bash:    JUMP_SECONDS=3700 npx hardhat run scripts/dev-timejump.js --network localhost
//   PowerShell:  $env:JUMP_SECONDS=3700; npx hardhat run scripts/dev-timejump.js --network localhost
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error("time jump is for the local demo chain only");
  }
  const secs = Number(process.env.JUMP_SECONDS || 3700);
  const before = (await ethers.provider.getBlock("latest")).timestamp;
  await ethers.provider.send("evm_increaseTime", [secs]);
  await ethers.provider.send("evm_mine", []);
  const after = (await ethers.provider.getBlock("latest")).timestamp;
  console.log(`chain time jumped: +${after - before}s → ${new Date(after * 1000).toISOString()}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
```

要点：

- **跳 3700 秒**（默认）即可越过 1 小时结算宽限期；跳完任何人都能在结算页看到红色 **Forfeit to charity** 按钮（无需权限）。
- 时间只能前进不能倒退。**先录需要 settle 的成功路径，再快进录罚没路径**——跳过宽限期后，未结算的成功会话签名会过期（attestation expiry = settlementDeadline），无法再 settle。
- 时间快进**不能**缩短专注监控本身：证明服务按墙钟心跳判定覆盖度，链上时间跳了、心跳没跑够照样判违规。想快就创建 1–2 分钟的会话。
- 打卡类（Supervised）会话的 periodIndex 按链上时间算，大跨度快进后再打卡会因 period 错位被拒——监督模式演示也请排在大快进之前，或快进后新建会话。

### 7.2 本地链重启注意事项

T1 的 Hardhat 进程一停，链上状态（会话、NFT、余额变动）**全部清空**。重启后：

1. 重新部署（3.2）；Hardhat 确定性链上地址通常与上次相同，但以新输出为准并核对 `deployments/localhost.json`。
2. 如地址变了，同步改三个 `.env` 并重启 T3/T4/T5。
3. **每个 MetaMask 账户清活动数据**（第 4 节的 nonce 坑）。
4. 前端页面强刷一次。

若 8545 端口被占、链起不来：多半是上次的 node 进程成了孤儿。Windows `netstat -ano | findstr :8545` 找到 PID 后按 PID 结束它（macOS/Linux：`lsof -i :8545`），再重启并重新部署。

### 7.3 演示前的环境体检清单

录前 2 分钟过一遍：

- [ ] 5 个终端进程都在；`curl :3001/health` 的 signer = 部署输出的 Attester 地址
- [ ] MetaMask 在「Local Hardhat」网络、演示账户余额约 10000 ETH
- [ ] 本次开机后未重启过链（重启过就先清 MetaMask 活动数据）
- [ ] 浏览器只开演示需要的标签页（专注会话页切走 = 违规）
- [ ] 双人段落：两个浏览器分别登录 A、B，昵称已设好

## 8. 可选：无头全链路自检

不想手工过 UI 时，仓库自带两个无头演练脚本（headless Chrome + 脚本化钱包，自动起停链与两个服务，按演示尺寸的窗口参数跑完全部四种模式并逐屏截图）：

```bash
# 仓库根（需先 npm install && npx hardhat compile；attester 需 npm run build）
node frontend/scripts/ui-walkthrough.mjs          # 四模式主链路，约 12 分钟，截图在 frontend/walkthrough-shots/
node frontend/scripts/ui-social-walkthrough.mjs   # 社交层 + My Zoo（另需 backend install/build）
```

它们适合录前自检"环境没坏"，不替代真人演示录制。

## 9. 排障速查表

通用安装/启动问题（npm 找不到、bootstrap.js 缺失、.env.txt 陷阱、端口占用、私钥格式错、health signer 不符等）见根 `README.md` 的 **Troubleshooting** 表，此处只补演示场景新增坑：

| 症状 | 原因 / 解法 |
| --- | --- |
| MetaMask 交易报 `nonce too high` / 一直 pending | 本地链重启过，MetaMask 缓存了旧 nonce。设置 → 高级 → 清除活动标签页数据（每个导入账户）。 |
| 前端一直停在「Wrong network」 | `frontend/.env` 没设 `VITE_CHAIN_ID=31337`，或改了 .env 没重启 vite。 |
| 前端连上链但创建会话报合约无代码 | `VITE_CONTRACT_ADDRESS` 指向旧部署（链重启过）。核对 `deployments/localhost.json`，改 .env，重启 vite。 |
| 结算页「Fetch attestation & settle」一直 425 转圈 | 链上时间还没到 endTime（本地链开了间隔出块时约等会话结束即可）；或证明服务刚重启还在 finalize，稍候重试。 |
| 取签名返回 409 refused | 会话已被判违规（切过页 / 心跳断 >15s / 绑定太晚）——这是 fail-closed 的预期行为，不是 bug；换一条新会话演示成功路径。 |
| 罚没按钮（Forfeit to charity）是灰的 / 找不到 | 链上时间没过 settlementDeadline（endTime + 1 小时）。跑 7.1 的时间快进脚本。 |
| 打卡上传后审核列表看不到 / 锚定失败 | 社交登录没做（先 Sign in with wallet）；或链时间被快进导致 period 错位（7.1 末条）。 |
| My Zoo 里看到 4 只没铸过的兽 | 这是 dev server 的演示样本架：当前账户没有真实铸造时才显示，标注了 "Demo shelf"。有真兽后只显示真兽。 |
| 某服务启动即退、报 `EADDRINUSE :3001/:4000/:5173` | 旧进程没关。Windows `netstat -ano \| findstr :端口` 查 PID 后按 PID 结束，重启该服务。 |
| `e2e-*.js` 脚本复跑失败（token id 不对、`OutsideSettlementWindow`） | 所有 e2e 脚本都假设全新链：重启链 → 重新部署 → 再跑。 |
