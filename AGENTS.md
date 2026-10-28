1. 每次开发完删除临时无用的文件，减少不必要冗余。
3. 每次开发完修改完，如果需要生成新的安装包，都请帮我自动生成安装包，注意都要放在release，这个也是发布文件夹，将 MAC 和WIN的分开，历史的旧的安装包就可以直接删除了（除非有经典版本，我让你存档）。如果是Mac电脑上，那么就自动打包MAC+WIN，如果是在Win电脑上，那么只打包Win即可（因为MAC无法在WIN打包？）。 release无须每次都推送Github, 除非我告诉你要推送。
4. 每次需要更新文档。
5. 重要信息，请自动更新本AGENTS.md文件。
6. 预览列表编辑使用原生列表拆分并同步 Markdown；编号选择和清除格式必须按预览当前光标定位，避免修改另一行。回归命令为 `npm --prefix dev run test:lists`（Electron 测试先清除 ELECTRON_RUN_AS_NODE）。
7. 有序列表起点设置通过点击编辑区序号打开；预览保留原生 marker，源码区使用捕获阶段点击处理，禁止在列表正文中插入交互控件。
8. 未保存关闭统一三按钮与放弃二次确认；Esc 默认返回编辑器。窗口关闭必须等待渲染层保存检查，不可直接销毁窗口。回归 `test:close`，发布流程见 docs/发布指南.md。
9. 大纲使用 Markdown 语法树提取标题，排除代码块，开关存于 mdx.outline。Windows 文件关联使用无扩展名 build/icons/icon；Mac 文件关联复用应用 ICNS，不重复指定同名图标，避免 electron-builder 25 硬链接冲突。回归 test:outline，发布前验证 Mac CFBundleTypeIconFile。
10. README 截图必须由真实渲染器和公开示例生成，不使用用户文档；通过 capture-readme.js 隔离会话并验证预览输入同步。纯文档与截图更新无需重新打包。

11. README 功能 GIF 用 `dev/scripts/capture-readme-gifs.js` 从隔离的真实渲染器生成，需 FFmpeg；验证源码输入到预览、主题切换及预览输入回写源码。上传视频转制动画仅作视觉介绍，不标为应用操作录像。复现见 docs/截图说明.md。

12. PDF / HTML 导出共用渲染与本地图片嵌入逻辑；PDF 必须通过独立沙盒窗口的受限 CSP 打印为浅色 A4，清理临时 HTML 与隐藏窗口，取消不输出，失败明确提示。回归 `test:pdf` 需 Electron 和 Poppler 工具，包含实际 PDF 文本、分页与图片检查。

13. 发布使用 GitHub Actions 原生 Mac/Windows 构建；可用 publish.yml 复用双端成功的构建产物。草稿按数字 Release ID 校验与发布，避免 tag 查询 404 导致重复草稿；不得覆盖已发布版本或跳过资产 SHA256、更新清单 SHA512 校验。Mac 本地签名不等于 Apple 公证。

14. 文档 dirty 必须比较正文与 savedContent，加载/切换不算编辑；每标签独立 EditorState 与撤销历史。延迟侧栏任务只能渲染，不能重标 dirty。空白新文档免关闭确认，已有文件清空仍需确认。回归 test:documents。
15. 后台关闭只隐藏主窗口；Cmd+Q / 真正退出必须走关闭全部握手，列出所有未保存文件，取消或失败保留文档。最近关闭只记录路径、不保存已放弃编辑；重命名不覆盖同名文件，也不隐式保存正文。

16. Electron 33 的 net.fetch 在 manual 重定向遇 302 会抛 Redirect was cancelled；更新下载和备用检查必须用 update-fetch.js 的 net.request 适配，逐跳验证地址，保留大小与 SHA256 校验。回归 test:update-network / test:update-flow 用真实 Electron HTTP 跳转，父进程退出后清理 profile 并检查完成证明。
17. Mac 文件关联使用 file-assoc-mac.js 和原生 Launch Services 助手，绝不调用 reg.exe。beforePack 在 Mac 编译通用助手，随包分发并签名；UTI 与七种扩展名一致。只在用户点击修复时设置默认应用；测试 test:mac-assoc 和隔离 Mac runner 的 verify-mac-assoc-native.js。
