# dsh-family-kit 的 profile 补丁层（模板）。
#
# tools/apply.mjs 把这里的占位符换成真实值，写到：
#   runtime/home/profiles/web/cordis.patch.yml
# 所以别直接改那份生成物——下一次收敛就覆盖了。要改就改这个模板，然后推送。
#
# 占位符：kit 路径 / data 路径 / 看谁饮食的 QQ / 保留天数。

# 生活面板：账本读主电脑同步过来的 data/balance/ledger.json；
# 饮食读 data/diet/diet.json（容器里那份 diet.db 的导出），并锁成只读。
- id: dsh-balance
  config:
    root: '{{DATA}}/balance'
    readOnly: true
    dietSnapshot: '{{DATA}}/diet/diet.json'
    dietQq: '{{DIET_QQ}}'

# 默认模型：和主电脑一致（DeepSeek 官方 provider，flash + 最大思考）。
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: max

- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-09-28.1
