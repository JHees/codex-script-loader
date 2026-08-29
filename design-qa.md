# Design QA — Loader 插件管理（0.5.6）

## 参考与范围

- 参考界面：Codex 系统设置中的原生“插件”页面。
- 参考截图：`.runtime/product-design-audit/17-native-plugin-actions-reference.png`
- 实现截图：`.runtime/product-design-audit/21-loader-plugin-metadata.png`
- 说明截图：`.runtime/product-design-audit/22-loader-description-tooltip.png`
- 菜单截图：`.runtime/product-design-audit/23-loader-system-remove-menu.png`
- 视口：1513 × 902 CSS px，设备像素比 2；参考与实现使用同一受管 renderer、同一视口采集。
- 约束：Loader 的通用插件清单目前不提供图标；更新状态、单插件更新动作、启用状态及自动更新状态必须保留；自动更新开关只放在“更多操作”中；不保留“最近移除”。

## 对照结论

此前五列表格在 768 px 的系统设置内容宽度中产生横向挤压，操作列脱离主内容，是阻断性布局问题。本轮改为与原生插件页一致的无表头列表：每个插件是一行、左侧集中显示身份与状态、右侧集中显示行级动作和启用开关；列表宽度保持 768 px，行圆角为 20 px，无外框与竖向分栏。

实现与原生页面保持了相同的主要视觉语法：窄内容列、轻量列表行、悬停底色、紧凑按钮、黑色主动作、右侧开关和系统字体层级。Loader 特有的更新摘要作为第二行保留，使“检查结果、上次检查时间、自动更新状态”无需进入二级界面即可查看。

## 交互验收

- “检查插件更新”“重载插件”“安装插件 ZIP”保留，安装为黑色主动作。
- Bennett UI 行显示更新失败、上次检查时间、自动更新已开启，并提供“检查更新”。
- 每个插件保留独立更新状态与适用的更新动作。
- 行末“更多操作”使用与官方来源一致的 28 × 28 横向三点图标按钮；按用户指定顺序位于启用开关右侧。
- 插件标题旁使用从 Codex 官方帮助入口提取的问号圆形矢量符号；鼠标悬停或键盘聚焦显示简短说明，移开或失焦关闭。Bennett UI 实测说明为 “Bennett UI, maintained for Codex through Codex Script Loader.”，自动验收结果为 `tooltipClosed: true`。
- “说明”不再占用“更多操作”菜单；Bennett UI 菜单仅包含“关闭自动更新、重新加载、移除”。点击插件信息区后菜单关闭，自动验收结果为 `outsideClickClosed: true`。
- “移除”复用 Codex 系统危险操作 token `--color-text-danger`，实测颜色为 `rgb(224, 46, 42)`，同时沿用系统菜单项的 28 px 高度与圆角。
- 插件副标题改为“作者 · GitHub 仓库地址 · 版本 · 启用状态”；当前 Bennett UI 显示 `JHees · github.com/JHees/better-ui-improvements-for-codex · 版本 1.4.12 · 运行中`，内置示例显示 Loader 自有仓库地址。
- Example UI 为内置插件，显示“随 Loader 更新”，禁用状态开关不可用。
- 已禁用插件不再暴露其插件设置页入口。
- 页面中不存在“最近移除”或恢复入口。
- 热重载后的实现修订为 `0.5.6-native-plugin-list-metadata-tooltip-final`，插件 lifecycle 无失败项。
- 菜单也支持按 Escape 关闭，并在离开 Loader 页面时移除 document 级事件监听器。

## 必查视觉表面

- 字体与排版：沿用 Codex 设置页现有字体、14 px 行级文本和弱化次要文字；未发现新增换行或截断问题。
- 间距与布局：官方按钮和实现均为 28 × 28；实现中开关 x=1214.41、三点按钮 x=1254.41，按钮处于行最右端，间距 8 px。
- 色彩与视觉 token：按钮使用系统 `text-tertiary`、透明边框及 `primary-ghost-hover`，打开状态具有与系统一致的弱底色。
- 图标质量：更多操作使用从官方插件页测得的 21 × 21 横向三点矢量源，说明使用从官方帮助入口提取的 20 × 20 问号圆形矢量源并显示为 16 × 16；未使用文字字符或近似占位符。
- 文案与内容：可见文字按钮“更多操作”已移除，保留同名 `aria-label`；更新失败动作继续显示“检查更新”。

## 比较历史

- P2（此前）：文字“更多操作”按钮过宽，且不符合官方行末图标式操作。修复为 28 × 28 三点按钮，并把开关与菜单按钮收敛到行末。
- P2（本轮）：副标题曾显示内部插件 ID，说明占用菜单项，移除动作沿用普通按钮语法。现已分别改为作者与仓库元数据、标题旁悬浮说明和系统危险菜单样式。
- 修复后证据：`21-loader-plugin-metadata.png`；作者、仓库、版本、状态与行末操作顺序经 DOM 测量通过。
- 悬浮态证据：`22-loader-description-tooltip.png`；说明浮层使用系统表面、边框、圆角与阴影，未遮挡行级操作。
- 打开态证据：`23-loader-system-remove-menu.png`；菜单锚定在按钮右下方，“说明”已移除，“移除”使用官方危险色。
- 外部点击证据：Loader CDP 自动交互确认 `outsideClickClosed: true`，无插件 lifecycle 失败项。

## 视觉差异与取舍

- 原生插件页使用插件图标；Loader 当前通用插件接口没有图标字段，因此本轮没有伪造或硬编码第三方图标。这是接口约束，不是视觉缺漏。
- Loader 行高约 77 px，高于原生约 60 px；额外高度用于常显更新摘要，满足插件市场式更新反馈要求。
- “本地/内置”来源标签是 Loader 管理本地包所需的信息，保持为弱化徽标。

## 最终判定

- P0：0
- P1：0
- P2：0
- P3：0（上述差异均为已确认的产品约束）
- 结论：通过。当前实现可以交给用户进行本地交互测试；尚未提交或推送。

final result: passed
