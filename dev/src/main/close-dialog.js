// 所有关闭入口共用中文提示；Esc 和关闭弹窗始终返回编辑器。
async function confirmClose(dialog, parent, names) {
  const title = names.length === 1 ? `「${names[0]}」有未保存的修改` : `${names.length} 个文档有未保存的修改`;
  const result = await dialog.showMessageBox(parent, {
    type: 'question', title: '关闭前保存文档', message: title,
    detail: '是否保存修改后关闭？选择“返回确认”可返回编辑器检查文档。',
    buttons: ['保存并关闭', '放弃保存', '返回确认'], defaultId: 0, cancelId: 2, noLink: true
  });
  if (result.response === 0) return 'save';
  if (result.response !== 1) return 'cancel';
  const again = await dialog.showMessageBox(parent, {
    type: 'warning', title: '确认放弃保存', message: '确定放弃未保存的修改吗？',
    detail: '放弃后将关闭文档，未保存的修改将丢失，且无法恢复。选择“返回确认”可返回编辑器检查文档。',
    buttons: ['确认放弃保存', '返回确认'], defaultId: 1, cancelId: 1, noLink: true
  });
  return again.response === 0 ? 'discard' : 'cancel';
}
module.exports = { confirmClose };
