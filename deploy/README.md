# 部署系统结构（deploy/）

一键部署与运维的全部代码都在这里。设计上遵循几条硬规则：

- **入口极薄**：`install.sh` 只负责定义全局变量、解析参数、分发子命令，具体功能都在 `lib/` 里。
- **模块只放函数**：`lib/*.sh` 里不允许出现顶层赋值或流程控制，全部被 `source` 进主脚本后才会执行。
- **不重复造轮子**：菜单和命令行调用的是同一批函数，不存在「菜单能做、命令行不能做」。
- **可重复执行**：已存在的 `.env`、数据库和数据目录不会被覆盖。

## 目录

```
deploy/
├── install.sh          # 入口：全局变量 + 载入模块 + 参数解析 + 分发
├── lib/                # 按职责拆分的函数模块
│   ├── common.sh       # 终端 UI、日志、错误处理、用法说明、依赖小工具
│   ├── detect.sh       # 环境探测：Docker、发行版、公网 IP、镜像加速开关
│   ├── docker.sh       # Docker 安装、镜像加速、Compose 封装、镜像构建
│   ├── config.sh       # .env 生成与读写、配置档、断点续跑状态机
│   ├── security.sh     # 随机密钥生成
│   ├── source.sh       # 代码获取：版本解析、克隆、下载、本地版本记忆
│   ├── access.sh       # 访问入口：IP+端口、域名、HTTPS 证书、防火墙
│   ├── version.sh      # 版本检测：本地与远端比较、更新范围判定
│   ├── upgrade.sh      # 升级与回滚事务
│   ├── installer.sh    # 安装流程：预检、向导、分步安装、安装后引导
│   ├── backup.sh       # 备份、定时备份、迁移打包、恢复
│   ├── service.sh      # 启停、状态、日志、部署信息
│   ├── doctor.sh       # 系统体检：分级诊断与修复建议
│   ├── extras.sh       # 服务器家底、测速、调优、磁盘清理
│   └── menu.sh         # 交互菜单、终端快捷键、全局 qingyu 入口、卸载
├── Dockerfile          # 应用镜像
└── Caddyfile           # 域名模式下的反向代理配置
```

## 为什么拆成模块

这套脚本原本是单个 5000 多行的 `install.sh`。它能跑，但有三个现实问题：

1. **改一处要通读全文**：任何函数都能调用任何函数，没有边界。
2. **无法单独验证**：语法错误、模块缺失，只有整个脚本跑起来才暴露。
3. **`curl | bash` 之外没有第二种加载方式**：单元测试只能对着一整份文本做字符串断言。

拆分后，`tests/install-script.test.ts` 会对**每个模块**单独跑 `bash -n`，并断言模块里没有混进顶层代码 —— 拆分本身因此是被测试守住的，而不是靠人自觉。

## 模块之间怎么加载

`install.sh` 在解析参数**之前**按固定顺序 `source` 所有模块：

```bash
for _qy_m in common.sh detect.sh docker.sh ... menu.sh; do
  . "$_qy_lib/$_qy_m.sh"
done
```

提前全部载入，是为了保证脚本执行到任何一行时用到的函数都已经定义 —— bash 的函数是后绑定的，本来不需要这个顺序，但显式写出来更不容易在重构时踩坑。

## 通过管道安装（`curl | bash`）

单文件时代 `curl … | bash` 直接就能跑。拆成多文件后，管道里只有 `install.sh` 一个文件、没有旁边的 `lib/` 目录，所以入口做了兼容处理：

- 找不到 `lib/` 时，用 `git clone --depth 1` 取一份完整仓库到临时目录，再 `exec` 真正的 `deploy/install.sh`，参数原样透传。
- 没有 `git` 时给出明确提示，而不是继续往下跑出一堆看不懂的「命令未找到」。

也就是说，**两条安装方式都仍然可用**：

```bash
# 方式一：管道（会先拉一份完整仓库）
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash -s -- --domain blog.example.com

# 方式二：仓库内直接运行（无需二次下载）
./deploy/install.sh --domain blog.example.com
```

## 加新功能时

1. 先判断它属于哪个模块；都不像就新建 `lib/<职责>.sh`。
2. 在 `install.sh` 的 `for` 循环里加上新模块名 —— 测试会断言**每个** `lib/*.sh` 都被载入，漏加会直接失败。
3. 如果是新的子命令：`lib/` 里写 `cmd_xxx()`，在 `install.sh` 末尾的 `case "$COMMAND"` 里加一条，并在 `usage()` 里补上说明 —— 测试会检查「用法里写了但没解析」和「解析了但用法里没写」两个方向。
4. 新模块同样只能放函数定义，否则 `lib 模块里没有残留可执行顶层代码` 这条测试会拦下来。
