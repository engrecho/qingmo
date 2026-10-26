1. 每次开发完删除临时无用的文件，减少不必要冗余。
3. 每次开发完修改完，如果需要生成新的安装包，都请帮我自动生成安装包，注意都要放在release，这个也是发布文件夹，将 MAC 和WIN的分开，历史的旧的安装包就可以直接删除了（除非有经典版本，我让你存档）。如果是Mac电脑上，那么就自动打包MAC+WIN，如果是在Win电脑上，那么只打包Win即可（因为MAC无法在WIN打包？）。 release无须每次都推送Github, 除非我告诉你要推送。
4. 每次需要更新文档。
5. 重要信息，请自动更新本AGENTS.md文件。
6. 预览列表编辑使用原生列表拆分并同步 Markdown；编号选择和清除格式必须按预览当前光标定位，避免修改另一行。回归命令为 `npm --prefix dev run test:lists`（Electron 测试先清除 ELECTRON_RUN_AS_NODE）。
7. 有序列表起点设置通过点击编辑区序号打开；预览保留原生 marker，源码区使用捕获阶段点击处理，禁止在列表正文中插入交互控件。
8. 未保存关闭统一三按钮与放弃二次确认；Esc 默认返回编辑器。窗口关闭必须等待渲染层保存检查，不可直接销毁窗口。回归 `test:close`，发布流程见 docs/发布指南.md。
9. 大纲使用 Markdown 语法树提取标题，排除代码块，开关存于 mdx.outline。文件关联图标使用无扩展名 build/icons/icon，由构建器分别选择 ICNS / ICO。回归 test:outline，发布前验证 Mac CFBundleTypeIconFile。
10. README 截图必须由真实渲染器和公开示例生成，不使用用户文档；通过 capture-readme.js 隔离会话并验证预览输入同步。纯文档与截图更新无需重新打包。
