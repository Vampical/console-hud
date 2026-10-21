'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function migrate(fromVersion, toVersion, settings) {
    // Toolbox calls the migrator with null when config.json does not exist yet.
    // Import older installations once; an existing config.json always takes precedence.
    if (fromVersion === null && !fs.existsSync(path.join(__dirname, 'config.json'))) {
        const legacyFile = path.join(__dirname, 'module_settings.json');
        try {
            const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8').replace(/^\uFEFF/, ''));
            settings = legacy && legacy.version !== undefined && legacy.data !== undefined ? legacy.data : legacy;
        } catch (error) {
            if (error.code !== 'ENOENT')
                console.warn('[console-hud] Could not import module_settings.json; using default settings. ' + error.message);
        }
    }
    return {
        enabled: settings?.enabled !== false,
        laurelStyle: settings?.laurelStyle === 'default' ? 'default' :
            settings?.laurelStyle === 'console' || settings?.laurelStyle === 'round' ? 'console' : 'classic',
        partyHpPercent: settings?.partyHpPercent === true,
        partyEffectsRight: settings?.partyEffectsRight === true
    };
};
