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

