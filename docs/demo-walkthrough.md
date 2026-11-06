# StakeBeast 创意功能全流程演示脚本

> 供队员录制本地链演示视频使用。前置：按 `docs/local-deploy-guide.md` 搭好环境（5 个终端运行中、MetaMask 已配好本地链与账户）。英文版视频脚本随 M4 另行交付（DAPP-65），本文是中文版全流程执行脚本。
>
> 约定：用户 A = Hardhat 账户 #3，用户 B = 账户 #4，Admin = 账户 #0，Charity = 账户 #2。全程质押用 0.05 ETH、专注时长用 1–2 分钟（合约下限 1 分钟），把等待压到最短。全流程约 13–14 分钟，留出开场收尾后在 15 分钟限制内。
>
> 界面语言为英文，括号内给出口播可用的中文解释。

## 时间线与会话规划

| 段 | 内容 | 会话 | 预估时长 |
| --- | --- | --- | --- |
| 1 | 开场叙事 | — | 0:45 |
| 2 | 单人专注成功路径 | A：SoloFocus 2 min（会话 S1） | 3:00 |
| 3 | 违规与罚没路径 | A：SoloFocus 1 min（S2）+ 时间快进 | 2:30 |
| 4 | 好友监督模式 | A→B 监督：Supervised 1 day（S3）；认输变体（S4） | 2:30 |
| 5 | 双人对赌 | A vs B：Duel focus 1 min（S5/S5'） | 2:00 |
| 6 | 双人共同专注 | A+B：CoFocus 1 min（S6）+ 时间快进 | 2:00 |
| 7 | 管理员作废兜底 | A：SoloFocus 不起动（S7） | 0:45 |
| 8 | 收尾：动物园 + 信任模型 | — | 1:00 |

顺序经过编排：所有需要 `settle` 的成功结算都在任何时间快进**之前**完成；第 3、6 段各做一次时间快进。跳过的会话不再回头结算（签名有过期性）。

---

## 第 1 段 · 开场：产品与承诺机制（0:45）

**叙事要点**：一句产品定位——"Stake to raise a beast. Break your word, and it runs."（质押养兽：立下承诺押上真金，完成则赎回押金并养大一只专属兽，违约则押金按事先约定的路由罚没）。点出承诺机制（commitment device）× 养成损失厌恶的组合创意：你有损失在场，且损失具象化为"兽跑了"。

**观众应看到**：首页深色"夜林"主题、荧光绿主色、🐾 导航 logo 与首页大标题。

**演示者操作**：
1. 浏览器打开 `http://localhost:5173`，停在首页。
2. 口播产品定位，点导航简单扫过 Create / Review / My Zoo 入口。
3. 一句话预告四种模式：单人专注、好友监督、双人对赌、共同专注。

## 第 2 段 · 单人专注成功路径（3:00，S1）

**叙事要点**：机器证明模式——证明服务用心跳监控"你是否真的在专注"，完成则链上凭 EIP-712 签名结算、铸造灵魂绑定兽 NFT。

**链上操作**：`createSession(SoloFocus)` 质押 0.05 ETH → 钱包 `personal_sign` 绑定 → `startSession` → 心跳 2 分钟 → 取 attestation → `settle` → 铸兽 → `withdraw`。

**观众应看到**：创建表单与档位提示 → 兽从蛋到成形的成长动画 → 结算绿色成功卡 → My Zoo 真兽 → 押金回到钱包。

**演示者操作**：
1. 连接用户 A。Create → Solo Focus：Stake `0.05`、Focus duration `2` 分钟（口播档位阶梯：≥120 分钟 Golden、≥50 Adult、≥25 Juvenile、以下 Sprout——"今天我们跑 2 分钟，所以是幼苗档"）。Forfeit destination 保持 Charity。**Stake & Create**，MetaMask 确认。
2. 跳转专注页后点 **Enable focus tracking**，完成一次钱包签名（口播：这是与证明服务的绑定握手，免 gas；开始窗口 1 小时内必须启动，否则可取消退款）。
3. 点 **Start session** 并确认交易。镜头给到中央：兽蛋随进度裂开、孵化、成形（15%/40%/65%/90% 四个阶段），底部心跳计数每 5 秒跳动一次。口播：整个窗口任何切页、隐藏标签或心跳中断超过 15 秒都会被记为违规。
4. 倒计时结束出现「Coverage verified」→ 点 **Go to settlement** → **Fetch attestation & settle**（口播：前端正在向证明服务取签名，服务只有在链上确认窗口结束且覆盖干净后才签——fail-closed）。
5. 绿色结果卡「Beast minted, stake returned」，点 **View in My Zoo** 展示刚铸的兽（Sprout 幼苗，头戴叶子帽）。
6. 回结算页，顶部 **Withdrawable balance** → **Withdraw**，MetaMask 里余额回升（口播：净成本只有 gas）。

## 第 3 段 · 违规与罚没路径（2:30，S2）

**叙事要点**：违约的代价真实发生——切页即违规，证明服务拒签，结算宽限期过后押金由任何人触发归慈善。信任模型的"硬"就在这里：没有申诉入口，规则在合约里。

**链上操作**：`createSession` → `startSession` → visibility 违规上报 → 服务判 violation → 快进到结算截止 → permissionless `forfeit` → charity `withdraw`。

**观众应看到**：黄色「Violation flagged」警告 → 服务确认违规、野兽逃跑动画 → 时间快进（终端）→ 红色「Forfeit to charity」→ 失败卡显示资金真实流向 → charity 账户收到款。

**演示者操作**：
1. 用户 A 再建 SoloFocus：`0.05` ETH、`1` 分钟。Enable tracking → Start session。
2. **切到另一个浏览器标签页**停几秒再切回：页面弹出黄色警告「Violation flagged」，兽进入警告抖动状态；几秒后文案变为证明服务已记录违规（口播：事件已上报，违规不可撤销）。
3. 等 1 分钟窗口结束：红色「Session failed」卡，野兽跑走只留下枯萎苗——"The beast ran away. Failed sessions mint no NFT."
4. 终端 T2 执行时间快进（越过 1 小时结算宽限期）：
   ```bash
   JUMP_SECONDS=3700 npx hardhat run scripts/dev-timejump.js --network localhost
   ```
5. 回到该会话结算页，刷新后出现红色 **Forfeit to charity**（口播：无需任何权限，任何人都能触发；争议与弃权的终点都是慈善）。点击并确认。
6. 失败卡从链上事件读出真实流向：「settlement deadline passed → charity」。
7. 切换 MetaMask 到 Charity 账户（#2）打开结算页：Withdrawable balance 显示 0.05 ETH → **Withdraw**（口播：善款到账，全程无人经手可截留）。

## 第 4 段 · 好友监督模式（2:30，S3 + S4）

**叙事要点**：机器管不了的事（健身、学习打卡）交给人——打卡照片原图的 SHA-256 锚定在链上，监督人事后复核时浏览器会重新下载原图重算哈希比对，换图必露馅。确认权完全在监督人：确认则放行，不确认（争议）则截止期后归慈善。

**链上操作**：`createSession(Supervised)`（创建即 Active，窗口 1 天）→ 上传照片 + `checkIn` 锚定哈希 → 监督人 `verify` → 铸兽；（变体）`admitDefeat` 按预设路由赔付监督人。

**观众应看到**：打卡四阶段进度（哈希→上传→锚定→确认）→ 监督人审核列表 → 证据复核绿色「Anchored & matching」→ 链上确认 → 认输的二次确认弹窗与赔付。

**演示者操作**：
1. 前置：A、B 都已 Sign in with wallet 并设好昵称。
2. A 创建 Supervised Habit：stake `0.05`、Period `1` 天、Supervisor 填 B 的地址（#4）、Completion standard 填" gym check-in photo"之类、Forfeit destination 选 **Supervisor**（认输赔给监督人）。
3. 专注页打卡面板选一张照片 → **Upload & anchor on-chain**：四阶段进度走完，出现缩略图 + evidenceHash + 锚定交易 hash（口播：照片上链的不是图本身，而是原图字节的哈希，隐私与存证兼得）。
4. 切到 B 的浏览器，打开 **Review**：看到 A 的会话卡（昵称、criterion、目标）。展开 **Evidence**：浏览器重算哈希，显示绿色「Anchored & matching」。点 **Confirm completion on-chain** 并确认（口播：这是链上 verify，最终且不可逆）→ A 侧结算成功、铸兽（habit 轨 1 天 = Sprout）。
5. 认输变体（S4）：A 再建一个相同会话，直接在专注页点 **Admit defeat** → 二次确认「Forfeit your stake now along the preset route?」→ **Yes, admit defeat**（口播：创建时选的路由生效，0.05 ETH 直接判给 B；若选 Charity 则归慈善）。B 的结算页 Withdraw 收款。

## 第 5 段 · 双人对赌（2:00，S5/S5'）

**叙事要点**：两个人互相质押对赌同一件事的完成——双方各持一个仓位，互为对方的确认人（交叉确认）：你完成了，由对方确认放行；你认输，押金按路由赔给对方；双方都互不确认（争议），截止期后两份押金一起归慈善。自指性在合约层被禁止：你不可能做自己的确认人。

**链上操作**：A `createSession(Duel)` 指定 B 为对手 → B `joinSession` 出资镜像仓位（双方同时 Active）→ 中途 A `admitDefeat`（赔给 B）→ B 完成，A `verify` B 的仓位 → B 赎回 + 铸兽。

**观众应看到**：创建时对手地址实时校验 → B 侧"出资加入"页与 join 倒计时 → 双方仓位互为镜像的「Opponent position」卡 → 认输赔付 → 交叉确认铸兽。

**演示者操作**：
1. A 创建 Mutual Bet：Task style 选 Focus `1` 分钟、stake `0.05`、Opponent 填 B 地址（口播：本期不支持开放挑战，对手创建时指定；地址非法或填自己会被表单直接拦下）。Forfeit destination 选 **Opponent**。
2. 把页面 URL 发给 B（口播：URL 里就是会话 id）。B 打开后看到"出资加入同一赌注"页，选自己的罚没路由（Opponent），点 **Join & stake 0.05 ETH**。双方仓位同时激活。
3. 双方都点 Enable tracking / Start 保持页面在前台。十几秒后，A 点 **Admit defeat** 认输（口播：认输即按路由赔付——A 的 0.05 归 B）。
4. B 坚持到窗口结束。A 在自己页面底部的「Opponent position」卡点 **Verify opponent's completion**（口播：交叉确认——B 的完成由 A 确认；"只确认你能担保的事实"）。B 的仓位 Completed：赎回 0.05 + 铸兽，加上 A 赔付的 0.05。
5. 口播兜底：若 A 输不起拒不确认（争议），B 的仓位在结算截止期后由任何人 forfeit 归慈善——争议双输，所以理性确认。机制与第 3 段的 Forfeit to charity 相同，不再重复演示。

## 第 6 段 · 双人共同专注（2:00，S6）

**叙事要点**：连坐机制——两个人绑定同一窗口一起专注，任何一人违规，**两份**押金都归慈善。创建与加入都必须先过知情确认弹窗；罚没路由被合约强制锁死在慈善，不留选择。

**链上操作**：A `createSession(CoFocus)`（弹窗确认连坐）→ B `joinSession`（同样弹窗）→ 双方 `startSession` 握手确认 → B 切页违规 → 快进 → `forfeit` 双份归慈善。

**观众应看到**：连坐知情确认弹窗（创建方与加入方各一次）→ 双方确认启动的握手状态 → 两只兽并排成长、各自状态圆点 → 一人切页后双方同见失败结局 → 双份罚没。

**演示者操作**：
1. A 创建 Co-Focus Duo：`1` 分钟、`0.05` ETH（口播：Forfeit destination 下拉被禁用锁定为 Charity——"forced by joint liability"）。点 **Stake & Create** 弹出红色警示弹窗「Joint liability — please confirm」，口播弹窗文案后点 **I understand — stake with joint liability**。
2. B 打开 URL：看到开放伙伴席位提示，点加入时**同样弹出连坐确认**（口播：双方各自知情同意，缺一不绑定）。确认 **I understand — join with joint liability**。
3. 双方页面显示"两座已出资"，各点一次 **Confirm start**（口播：第二人确认时窗口才锚定上链）。进入双人视图：两只兽并排成长，各自座位下实时状态圆点（tracking / stale / violation）。
4. **B 切走标签页**：B 侧立即黄色警告，服务确认后圆点变 violation（口播：一人违规，连坐生效——结局对两人相同）。
5. 窗口结束，双方页面同为红色失败卡。终端做第二次时间快进（同第 3 段命令），回到会话结算页点 **Forfeit to charity**：失败卡显示「both stakes went to charity under joint liability」（口播：两份 0.05 一起归慈善，链上事件可核）。
6. （可选）再切 Charity 账户 Withdraw，余额从 0.05 涨到 0.15。

## 第 7 段 · 管理员作废兜底（0:45，S7）

**叙事要点**：平台故障的兜底闸门——只有合约 owner 能作废旧会话，效果是全额原路退回：不铸兽、不走罚没路由。它存在的意义是"平台出错时用户不受损"，不是平台权力。

**链上操作**：A 建会话（不启动）→ owner 调用 `voidSession` → A `withdraw` 全额退回。

**观众应看到**：owner 钱包视角下会话页底部独有的 Admin 卡与二次确认 → 作废后状态 → A 全额取回。

**演示者操作**：
1. A 创建 SoloFocus `1` 分钟（停留在 Pending，不启动）。
2. MetaMask 切到 Admin（#0，部署账户即合约 owner），打开该会话 URL：页面底部出现普通用户看不到的「Admin」卡，口播说明文案（"Platform-fault use only"）。点 **Void session** → **Confirm void**。
3. 状态变为 Voided。切回 A：结算页提示全额退回可提余额 → **Withdraw**（口播：全额退回、无罚没路由、无铸兽——作废只退本金）。

## 第 8 段 · 收尾：动物园与信任模型（1:00）

**叙事要点**：展示收集维度与信任模型一句话总结，收束全片。

**观众应看到**：My Zoo 的真实兽陈列 + 样本架四档对比。

**演示者操作**：
1. 打开 A 的 **My Zoo**：真实铸造的兽排在架上（第 2、4、5 段的战利品），口播收藏维度——四档成长阶梯（Sprout 叶帽 / Juvenile 毛线帽 / Adult 礼帽 / Golden 皇冠）× 七套调色板（由会话号决定，每只兽配色可能不同；Golden 强制金色）。
2. 切到一个没有真兽的账户（或新浏览器配置）展示样本架：24 分钟幼苗、25 分钟青年、50 分钟成年、120 分钟黄金四只并排（口播：这是空账户时的演示样本架；档位按承诺时长就低不就高——declared value，与实际耗时无关，防止"熬时间刷高档"）。
3. 一句话信任模型收尾：机器证明 fail-closed（服务不签=没完成，平台自己也无法放行）；人类证明认账赔付、争议归慈善；自指性禁止（自己不能监督自己）；所有资金走向都可从链上事件复核。

---

## 录制提示

- 录前过一遍部署指导第 7.3 节的体检清单；每段之间如链被重启，所有会话作废需重来（尽量一次录完，或分段录但同一条链的连续时间内）。
- 专注等待的 1–2 分钟不要停机尬等：用来口播该段的机制讲解（心跳 5 秒、15 秒宽限、绑定窗口 5 分钟等），或给成长动画特写。
- 时间快进终端操作可以录进画面：它是本地链特性（Hardhat 的 `evm_increaseTime`/`evm_mine`），旁白一句"本地链演示专用，真实网络上这段时间就是真实的一小时"即可。
- 双人段落建议双浏览器并排或画外音明确"现在切到 B 的电脑视角"。
- 所有终端输出、链上事件（交易 hash、claimable 余额变化）都是可展示证据；失败卡的"资金流向"是从链上事件读出的真实值，值得给特写。
