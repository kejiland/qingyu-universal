# 界面设计规范（配色与可读性）

> 适用范围：前台博客（`app/public/`）与管理后台（`admin/src/`）。
> 目的：新增页面或调整主题色时，颜色不会「看着好看但看不清」。

## 一、先跑检查

```bash
npm run check:contrast      # 不达标时退出码为 1，CI 会直接失败
npm run check:contrast -- --warn-only   # 只看不失败
```

这个脚本会自动读取两个样式表里的主题变量，逐项计算对比度，覆盖：

- 前台 / 后台 × 明色 / 暗色两套主题
- 前台 4 套主题配色（赭橙 terra / 靛蓝 indigo / 竹青 bamboo / 暮紫 dusk）× 明暗

## 二、对比度底线（WCAG 2.1 AA）

| 用途 | 最低对比度 |
| ---- | ---------- |
| 正文、链接、提示文字、表单说明 | **4.5 : 1** |
| 大标题（≥18.66px 粗体 / ≥24px） | 3 : 1 |
| 图标、边框、分隔线、图表色块 | 3 : 1 |
| 纯装饰元素（背景纹样、渐变） | 不限制 |

当前主题的实测值全部在 4.55:1 以上，改动后请重新跑一遍。

## 三、只允许用变量，不许写死颜色

前台（`app/public/style.css`）：

| 变量 | 用途 |
| ---- | ---- |
| `--fg` / `--muted` | 正文 / 次要文字 |
| `--bg` `--bg-soft` `--card` | 页面底 / 次级底 / 卡片底 |
| `--accent` `--accent-soft` `--accent-2` | 主色、柔化底、渐变搭档 |
| `--accent-fg` | **主色实心底上的文字色** |
| `--danger` `--danger-soft` | 危险提示 |

后台（`admin/src/style.css`）：

| 变量 | 用途 |
| ---- | ---- |
| `--ink` `--ink-soft` `--ink-muted` | 文字三级层次 |
| `--canvas` `--surface` `--surface-2` `--surface-3` | 画布 / 卡片 / 次级底 |
| `--accent` `--accent-hover` `--accent-soft` `--accent-fg` | 主色体系 |
| `--success` `--warning` `--danger` `--info`（各带 `-soft`） | 状态色 |

写死 `#c25e3a` 这类字面量是禁止的：换主题时会漏改，也是对比度检查抓不到的地方。

## 四、深色主题为什么要 `--accent-fg`

深色模式下主色为了在深底上清晰，会被调亮（例如赭橙 `#e08a63`）。
若按钮仍然写 `color: #fff`，对比度只有 2.63:1，远不达标。
因此约定：**主色实心底一律使用 `var(--accent-fg)`**：

- 明色主题：`--accent-fg: #ffffff`（主色本身够深，白字够清晰）
- 暗色主题：`--accent-fg: <深色>`（主色够亮，改用深色字）

后台主按钮已遵循此约定：

```css
.btn-primary {
  background: var(--accent);
  color: var(--accent-fg);
}
```

## 五、柔化底（`-soft`）的调整方向

- **明色主题**：主色要更深，柔化底要更淡（往白色靠）。
- **暗色主题**：主色要更亮，柔化底要更暗（往黑色靠）。

两边都错的时候，调整柔化底往往比调整主色更不容易破坏整体观感。

## 六、提交前检查清单

- [ ] 新增颜色是否都走了 CSS 变量
- [ ] 主色实心底上的文字是否用了 `var(--accent-fg)`
- [ ] 明暗两套主题都看过（浏览器切换主题后目视一遍）
- [ ] `npm run check:contrast` 通过
- [ ] `npm --prefix admin run typecheck` 通过
