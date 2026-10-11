# deploy/ — 一键部署脚本

给不会敲命令的人用的：装好 Docker、拉好代码、建好数据库、启动网站。
装完直接在浏览器打开网址就能用，密码和站名进后台「设置」里填。

## 怎么用

```bash
# 方式一：粘贴一行搞定（会先自动下载完整项目）
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash

# 方式二：已经 clone 了项目就直接跑
./deploy/install.sh
```

不填任何参数，全程不提问，跑完给你一个能打开的网址。

需要改端口或绑域名：

```bash
./deploy/install.sh --port 9000
./deploy/install.sh --domain blog.example.com
```

装完以后，敲 `qingyu` 就能打开数字菜单（安装、备份、升级、查状态都在里面），不用记这些命令。

## 文件怎么分的

```
deploy/
├── install.sh     入口：全局变量 + 载入模块 + 解析参数 + 分发命令
├── lib/           功能按职责拆开的 15 个模块
├── Dockerfile     应用镜像
└── Caddyfile      绑域名时的反向代理配置
```

`lib/` 里的模块只放函数，不写顶层代码；`install.sh` 在解析参数前按固定顺序全部载入。
这么拆是为了改一处不用通读全文件，出问题也能单独测一个模块。

**加新功能时**：先看该放进哪个模块，或者新建 `lib/<职责>.sh`；
然后**记得在 `install.sh` 的载入列表里加上它**（漏加测试会直接失败）；
新命令还要在末尾的 `case` 里加一条分发，并在 `usage()` 里补说明。

## 两种安装方式为什么都能用

方式一粘贴的是单个文件，旁边没有 `lib/` 目录。所以入口会检查：
找不到 `lib/` 就 `git clone` 一份完整项目到临时目录，再转去执行真正的脚本，参数原样带过去。

## 保障

改动 install.sh 或模块后，跑 `npx vitest run tests/install-script.test.ts`：
会检查每个模块的语法、模块是否都被载入、模块里有没有混进顶层代码、
以及用法里写了但没实现（或实现了但没写）的命令。CI 上也会跑同样的检查。