const fs = require('node:fs');
const path = require('node:path');
function preferences(app) {
  const file = path.join(app.getPath('userData'), 'preferences.json');
  let current = { closeToBackground: false };
  try { current.closeToBackground = JSON.parse(fs.readFileSync(file, 'utf8')).closeToBackground === true; } catch {}
  return {
    get: () => ({ ...current }),
    set: patch => {
      if (!patch || typeof patch.closeToBackground !== 'boolean') throw new Error('无效的关闭设置');
      const next = { closeToBackground: patch.closeToBackground };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(next), 'utf8');
      fs.renameSync(temporary, file);
      current = next;
      return { ...current };
    }
  };
}
module.exports = { preferences };
