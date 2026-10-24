'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { version } = require('./module.json');
const resources = {
    "client/S1UI_InteractionMenu.gpk": "44e0fa707c194fd6e196d4afc53a49c02d9bbe39c94cb2ef2eb7001e8c5979a9",
    "client/S1UI_CharacterWindow.gpk": "f28bffb1bda42e0a8aefcc0c2cff66ae32cc04a3124a03fb1042ceeea781b205",
    "client/S1UI_PartyAbnormalitySetting.gpk": "9f76794c0debf00428660e5796ca173817750aa20fbdd173c83243eac6a905cf",
    "client/S1UI_PartyWindow.gpk": "b9415b86ccaa439e0b268a751259c9b3b6793bf1cc61937a4d4ef95a8a20e997"
};

exports.ClientMod = class ConsoleHUDClient {
    constructor(mod) { this.mod = mod; }
    install(installer) {
        const mod = this.mod, info = mod.clientInterface.info;
        if (mod.settings.enabled === false) return;
        if (info.arch !== 'x64' || Number(info.majorPatchVersion) < 100)
            throw Error('Console HUD requires the x64 client (patch 100 or newer).');
        const nativeManager = mod.clientInterface.GPKManager;
        // Verify every package before registering any of them.
        const targets = new Map();
        for (const [resource, expectedHash] of Object.entries(resources)) {
            const file = path.join(__dirname, resource);
            const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            if (hash !== expectedHash) throw Error('Console HUD GPK checksum mismatch: ' + resource + '. Reinstall the module.');
            targets.set(file, nativeManager.getFullPath(path.resolve(mod.clientFolder, '..'), path.basename(resource)));
        }
        const symlink = fs.symlinkSync;
        let copied = false;
        // Keep Toolbox reference counting and cleanup, including Windows without symlink privileges.
        fs.symlinkSync = function (source, destination, type) {
            try { return symlink(source, destination, type); }
            catch (error) {
                if (!['EPERM','EACCES'].includes(error.code) || targets.get(path.resolve(source)) !== path.resolve(destination)) throw error;
                fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); copied = true;
            }
        };
        try { for (const resource of Object.keys(resources)) installer.gpk(resource); }
        finally { fs.symlinkSync = symlink; }
        mod.log('Console HUD v' + version + ': GPK registered through Toolbox clientInterface' + (copied ? ' (copy fallback)' : '') + '.');
        if (Number(info.majorPatchVersion) !== 100 || Number(info.minorPatchVersion) !== 2)
            mod.log('Console HUD GFX was built for 100.02; rendering on this patch has not been verified.');
    }
};
exports.NetworkMod = require('./network');
