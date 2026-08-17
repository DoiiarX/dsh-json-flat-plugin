# dsh-json-flat-plugin

> [English](README.md) | 中文

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

把 `jstool.py` 的 JSON 扁平视图 / 编辑工具封装为模型可用的 Cordis 工具的持久化
DeepSeek Harness 插件包。它是 `json-flat-tool` skill 的纯 JS 重实现（扁平视图、
schema 推断、搜索、基于路径的编辑），让 agent 能直接查看和修改 JSON，而不用
调用外部的 Python 脚本。

## 提供的功能

| 工具 | 作用 |
|------|------|
| `json_flat_view` | 把 JSON 值扁平化为 `路径 / 类型 / 值` 行。支持 schema 模式（折叠 `[N]→[*]`、去重、隐藏值）、`filter` 路径（元素感知），以及行/元素级分页（`limit` / `offset` / `elemOffset` / `elemLimit`）。 |
| `json_flat_schema` | 推断 JSON Schema Draft-7 结构（数组采样最多 20 项，`required` = 非空字段）。 |
| `json_flat_find` | 按正则（默认）或 glob（`*` 匹配任意字符串）搜索扁平化后的路径和/或值，可选忽略大小写。 |
| `json_flat_edit` | 基于路径的编辑：`set` / `del` / `set-null` / `before` / `after` / `copy` / `merge`。默认返回带紧凑逐路径 diff 的 dry-run 预览；传 `apply: true` 通过 `fs` 服务写回。 |

## 输入

- **只读工具**接受 `source`（内联 JSON 文本或 `@file`）和/或
  `file`（通过 `fs` 服务解析的路径）。即使没有 `fs`，内联 JSON 也能工作。
- **`json_flat_edit`** 需要 `fs` 服务，且始终作用于 `file`。
  dry-run 返回 `changes` 但从不写入；`apply: true` 原子地写回结果。
- **`@` 前缀与 `@@` 转义**：以单个 `@` 开头的字符串参数（`source` 或 `value`）
  表示从文件读取 JSON。要写入以 `@` 开头的字面字符串（如 npm 作用域包名
  `@scope/name`），用 `@@` 转义：`@@pkg` 写入字面值 `@pkg`（不读文件、不做
  JSON 解析）。

## 路径语法

```
count             根级键
users[0]          数组元素
users[0].name     嵌套键
root[0].key       根数组元素的键
root              根节点本身
```

## 设计说明

- 纯算法逻辑放在 `json-flat-core.js`（确定性、无运行时依赖），
  因此可独立单元测试，也能在 DSH 运行时之外复用。
- 修改型编辑在应用前捕获深拷贝，使返回的 diff 与修改前的状态对比
  （`apply*` 辅助函数原地修改）。
- Loader 入口（`index.js`）做了失败隔离：可选的 `fs` 服务和所有重量级 import
  都在 `apply()` 内解析，因此服务缺失或加载错误降级为诊断，而不会拖垮 profile。
- 只读工具从不写入；编辑是 `apply: true` 显式开启的，避免误修改。

## 开发

```bash
node --test test.mjs   # 核心算法
node smoke.mjs         # 工具注册 + 通过 mock ctx + fs 的端到端验证
```
