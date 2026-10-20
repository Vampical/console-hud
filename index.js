'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { version } = require('./module.json');
const expectedHash = '34150ac8564d5442b6b0f7f48412de91877bf2cb305b905c7a2c322360dec6ba';
const resource = 'client/S1UI_CharacterWindow.gpk';

exports.ClientMod = class ConsoleHUDClient {
    constructor(mod) { this.mod = mod; }
    install(installer) {
        const mod = this.mod, info = mod.clientInterface.info;
        if (mod.settings.enabled === false) return;
        if (info.arch !== 'x64' || Number(info.majorPatchVersion) < 100)
            throw Error('Console HUD requires the x64 client (patch 100 or newer).');
        const file = path.join(__dirname, resource);
        const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (hash !== expectedHash) throw Error('Console HUD GPK checksum mismatch. Reinstall the module.');
        const nativeManager = mod.clientInterface.GPKManager;
        const target = nativeManager.getFullPath(path.resolve(mod.clientFolder, '..'), 'S1UI_CharacterWindow.gpk');
        const symlink = fs.symlinkSync;
        let copied = false;
        // This Toolbox only falls back on EISDIR. Preserve its reference counts
        // and cleanup while handling Windows symlink permission errors as well.
        fs.symlinkSync = function (source, destination, type) {
            try { return symlink(source, destination, type); }
            catch (error) {
                if (!['EPERM','EACCES'].includes(error.code) || path.resolve(source) !== file || path.resolve(destination) !== target) throw error;
                fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); copied = true;
            }
        };
        try { installer.gpk(resource); }
        finally { fs.symlinkSync = symlink; }
        mod.log('Console HUD v' + version + ': GPK registered through Toolbox clientInterface' + (copied ? ' (copy fallback)' : '') + '.');
        if (Number(info.majorPatchVersion) !== 100 || Number(info.minorPatchVersion) !== 2)
            mod.log('Console HUD GFX was built for 100.02; rendering on this patch has not been verified.');
    }
};
exports.NetworkMod = require('./network');
