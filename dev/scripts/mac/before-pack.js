module.exports = async context => {
  if (context.electronPlatformName === 'darwin') require('./build-file-assoc');
};
