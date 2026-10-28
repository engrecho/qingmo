# macOS 打包指南

> 1.6.10 起请以 [发布指南](发布指南.md) 的原生 Mac 构建流程为准，beforePack 会编译并签名文件关联助手。下文历史的 Windows 交叉拼包方案未集成该助手，不能用于当前正式发布。

三种方案，按你的情况选。

---

## 零、Mac 上打包后如何双击打开（最快路径）

**在你自己的 Mac 上打，双击打开几乎不会有问题**，因为包是在本机生成的，
不经过下载，macOS 不会给它打隔离标记（quarantine）。

### 三步走

```bash
# 1. 拿代码（已有代码就跳过）
git clone https://github.com/engrecho/qingmo.git
cd qingmo

# 2. 打 dmg（同时会出 zip）
./dev/pack-mac.sh

# 3. 装上
open .cache/build/mac/*.dmg     # 挂载镜像
# 把「轻墨」拖进 Applications，然后双击打开
```

完。`pack-mac.sh` 会自动检查 Node 版本、装依赖、检查图标，然后调
`electron-builder` 出 dmg。

### 双架构（要给别人用，或同时支持 Intel Mac）

```bash
./dev/pack-mac.sh --both
```

### 不用脚本，手动来

```bash
cd qingmo/dev
npm install
npm run pack:mac          # dmg + zip
npm run pack:mac:dmg      # 只要 dmg
npm run pack:mac:zip      # 只要 zip
```

产物：`.cache/build/mac/轻墨-1.3.0.dmg`、`轻墨-1.3.0-mac-arm64.zip`、
`轻墨-1.3.0-mac-x64.zip`

### 首次打开仍提示「无法验证开发者」

本包已做 **ad-hoc 签名**（配置里 `identity: null`），Gatekeeper 只在
「从网上下载」时才拦。本机打的基本都能直接双击。

万一还拦，二选一：

```bash
# 方案1：右键打开（一次性）
#   在访达里右键点「轻墨」→ 打开 → 弹窗里再点「打开」

# 方案2：命令行放行
xattr -cr /Applications/轻墨.app
```

### 前置条件

| 需要 | 版本 | 检查命令 |
| --- | --- | --- |
| macOS | 10.15+ | 左上角苹果图标 → 关于本机 |
| Node.js | **18 或更高（LTS）** | `node -v` |
| 磁盘 | 约 3 GB | — |

Node 装法：去 <https://nodejs.org> 下 LTS 版 `.pkg`，双击一路下一步。

**架构对照**：M1/M2/M3/M4 选 arm64，Intel 选 x64。
`pack-mac.sh` 默认按你本机架构打，不用手动选。

---

## 一、正式发布（.dmg）

`.dmg` 是 macOS 的标准分发格式，有安装向导、能拖到 Applications。

```bash
cd qingmo/dev
npm install
npm run pack:mac
```

### 加上签名与公证（彻底消除「已损坏」提示）

未签名应用首次打开必须右键 → 打开。要彻底消除，需要 Apple 付费开发者
账号（$99/年）：

```bash
# 0. 先配置公证凭据（只需一次）
xcrun notarytool store-credentials "AC_PROFILE" \
  --apple-id "you@example.com" \
  --team-id "TEAMID" \
  --password "app-specific-password"

# 1. 解压 -> 签名 -> 重压
cd .cache/build/mac
unzip -q 轻墨-1.3.0-mac-arm64.zip -d signed

codesign --deep --force --options runtime \
  --sign "Developer ID Application: 你的名字 (TEAMID)" \
  --timestamp \
  signed/轻墨.app

# 2. 公证
xcrun notarytool submit signed/轻墨.app \
  --keychain-profile "AC_PROFILE" --wait

# 3. 装订票据（关键，不做这步还是提示损坏）
xcrun stapler staple signed/轻墨.app
xcrun stapler validate signed/轻墨.app

# 4. 重压并重打 dmg
rm 轻墨-1.3.0-mac-arm64.zip
cd signed && zip -qry ../轻墨-1.3.0-mac-arm64.zip 轻墨.app && cd ..
```

---

## 二、只打 .app 的 zip（Windows 交叉打包时用）

```bash
cd qingmo/dev
npm install
npm run mac:fetch
npm run pack:mac-x
```

**能做什么**：产出可用的 `.app` zip（结构与官方包完全一致）。

**不能做什么**：
- 出不了 `.dmg`
- 出不了签名版

---

## 三、在 Windows 上交叉打包（给自己在 Mac 上用）

Windows 上打不出 `.dmg`，但能出 `.app` 的 zip。**注意：这种包发给别人时，
对方首次打开必须右键 → 打开**（因为经过下载，带隔离标记）。

```bash
cd qingmo/dev
npm install
npm run mac:fetch     # 下载 Electron mac 运行时（约 200MB，只需一次）
npm run pack:mac-x    # 组装 .app 并压缩
```

**能做什么**：产出可用的 `.app` zip（结构与官方包完全一致）。
**不能做什么**：出不了 `.dmg`，出不了签名版。

---

## 四、「应用已损坏」的真凶与修复记录

如果你之前下载过早期版本的 mac 包并提示损坏，原因是打包方式有问题。

### 症状

解压 zip 得到 `轻墨.app`，双击或拖到 Applications 后打开报：
**「轻墨」已损坏，无法打开。**

### 根因

Electron 的 mac 框架里有 **14 个符号链接**，比如：

```
Electron Framework.framework/Electron Framework  ->  Versions/Current/Electron Framework
Electron Framework.framework/Versions/Current   ->  A
```

这些链接有两个苛刻要求：

1. **必须存在** —— 缺了 mac 就加载不了框架
2. **目标必须是相对路径** —— 转成绝对路径同样会失效

早期方案是「解压官方 zip → 改内容 → 重新压缩」。在 Windows 上：
- 无法创建符号链接（需管理员权限），一解压就丢了
- 就算用标记文件记录目标，重新压缩时也容易转成绝对路径

结果就是 mac 拿到一个**框架结构损坏**的应用 —— 报「已损坏」。

### 现在的做法

`dev/scripts/mac/build-mac.js` **不解压**，直接改官方 zip 里的条目：

```
读官方 zip → 逐条处理 → 写新 zip
  ├── default_app.asar  →  替换成我们的 app.asar
  ├── electron.icns     →  替换成我们的 icon.icns
  ├── Info.plist        →  改名称/标识/版本/图标声明
  ├── MacOS/Electron    →  改名成 MacOS/QingMo
  ├── Electron.app/     →  改名成 QingMo.app/
  └── 其余条目          →  原样复制（目录、符号链接、权限位全保留）
```

验证结果：

| 指标 | 官方包 | 新包 |
| --- | --- | --- |
| 目录条目 | 145 | 145 |
| 符号链接 | 14 | 14 |
| 文件条目 | 96 | 96 |
| 绝对路径链接 | 0 | 0 |

体积也从异常的 350MB 回到 95.5MB（与官方包一致）。

### 如果你还是打不开

按顺序试：

**① 右键打开**（最常见）

在访达里**右键点击** `轻墨.app` → 选「打开」→ 弹窗里再点「打开」。

**② 清除隔离属性**

```bash
xattr -dr com.apple.quarantine /Applications/轻墨.app
```

**③ 确认芯片架构**

```bash
uname -m          # 输出 arm64 = Apple 芯片，x86_64 = Intel
file /Applications/轻墨.app/Contents/MacOS/轻墨
```

选错架构包在 Rosetta 下通常也能跑，但如果提示架构不兼容，
去 Release 页面下载对应芯片的包。

**④ 检查包完整性**

```bash
unzip -l QingMo-1.3.0-mac-arm64.zip | grep -E "Versions/Current|app.asar"
```

应该能看到 `Versions/Current` 条目和 `app.asar`。

**⑤ 还是不行就在 Mac 上自己打**（见本文开头的「零、Mac 上打包后如何双击打开」），
用官方 `electron-builder`，不会有任何兼容问题。

---

## 常见问题

**Q：为什么 Windows 打不出 .dmg？**
`.dmg` 是磁盘映像，macOS 用 `hdiutil` 生成，Windows 无对应实现。

**Q：`identity: null` 是什么意思？**
让 `electron-builder` 自己做 **ad-hoc 签名**（用一个自签证书给自己签），
而不是去找付费开发者证书。效果是：Gatekeeper 认这个签名，本机打的包
可以直接双击。代价是没有公证票据，所以从网上下载时仍建议右键打开。

**Q：为什么把 `icon.icns` 加进 Git 了？**
因为它是打包的**必需输入**，不是产物。`gen-icons.js` 依赖 Windows 的 Edge
渲染 SVG 出 PNG，在 Mac 上跑不了。如果 `.gitignore` 排除了 `.icns`，
Mac 上 clone 完直接打包会因找不到图标而失败。

**Q：交叉打包的包能通过 Gatekeeper 吗？**
不能。签名和公证都需要 Apple 开发者证书，且公证必须在 mac 上跑
（需要访问 Apple 的 notary 服务并绑定 app）。

**Q：`.app` 里的 `轻墨.app` 为什么是 `QingMo.app`？**
`.app` 目录名和内部可执行文件名用 ASCII `QingMo`（macOS 命名惯例，
非 ASCII 名在部分系统调用下有兼容问题），但用户在访达和应用菜单里
看到的都是中文「轻墨」——由 `Info.plist` 的 `CFBundleDisplayName` 决定。

**Q：需要 Intel 版本吗？**
2020 年后的 Mac 都是 Apple 芯片。除非你要给很老的机器用，否则只需要 arm64。

**Q：Node.js 版本要求？**
18 或更高（`electron-builder` 25.x 的硬性要求）。装 Node 22 LTS 最稳。

**Q：打包要多久？**
首次 `npm install` 约 1-3 分钟，打包本身 30 秒到 2 分钟。
依赖装完后重复打包会快很多。

---

## 排查清单

打包报错时按这个顺序查：

| 症状 | 原因 | 解法 |
| --- | --- | --- |
| `Cannot find module 'electron'` | 没装依赖 | `cd dev && npm install` |
| `icon.icns not found` | 图标缺失 | 从 Release 下任意 mac 包取 `icon.icns` 放回 `dev/build/icons/` |
| `hdiutil: command not found` | 在 Windows 上打 dmg | 只能在 mac 上打 dmg；Windows 用 `npm run pack:mac-x` 出 zip |
| `requires Node.js >= 18` | Node 太老 | 升级到 LTS |
| 打得特别慢 | 首次下载 Electron 缓存 | 等一会儿，后续会走缓存 |
| 打出来 `dmg` 里 app 名是英文 | 缓存了旧配置 | `rm -rf ~/Library/Caches/electron-builder` 后重打 |

---

## 参考

- [Electron 打包文档](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [Apple 代码签名指南](https://developer.apple.com/documentation/security)
- [notarization 流程](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
