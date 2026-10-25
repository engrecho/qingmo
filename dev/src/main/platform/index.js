/**
 * 平台实现统一出口
 *
 * 按当前运行平台装载对应实现，main.js 只跟这里打交道，
 * 不出现任何 process.platform 分支。
 *
 * 新增平台：在 IMPLS 里加一条，再写一个 <平台>.js 即可。
 */
const IMPLS = {
  darwin: './mac',
  win32: './win'
};

// 未适配的平台使用默认行为，不下载其他平台的安装包
const chosen = IMPLS[process.platform] || './base';

module.exports = require(chosen);
