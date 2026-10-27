// A hidden window retains its tabs; actual quit always asks the renderer to close all.
function attachWindowClose({ app, window, ipcMain, keepInBackground }) {
  let approved = false, pending = false, quitting = false;
  const beforeQuit = () => { quitting = true; };
  const close = event => {
    if (approved) return;
    event.preventDefault();
    if (pending) return;
    if (!quitting && keepInBackground()) { window.hide(); return; }
    pending = true;
    if (!window.isVisible()) window.show();
    window.webContents.send('app:requestClose');
  };
  const finish = (event, result) => {
    if (event.sender !== window.webContents || !pending) return;
    pending = false;
    if (result === true) { approved = true; app.quit(); }
    else { quitting = false; window.show(); window.focus(); }
  };
  app.on('before-quit', beforeQuit);
  window.on('close', close);
  ipcMain.on('app:finishClose', finish);
  window.once('closed', () => {
    app.removeListener('before-quit', beforeQuit);
    ipcMain.removeListener('app:finishClose', finish);
  });
}
module.exports = { attachWindowClose };
