'use strict';
const path = require('path');
const codec = require('./settings-codec');
const { version } = require('./module.json');
const PartyInspect = require('./party-inspect');

// ACCOUNT UI data belongs to the running client, not its current character's
// network connection. Weak keys release it when the native client disconnects.
const clients = new WeakMap();
function clientSession(mod) {
    const client = mod.clientInterface;
    if (!client || typeof client !== 'object') return { account: null, accountId: null, users: new Map(), nonce: Date.now() % 1000000000 };
    let servers = clients.get(client);
    if (!servers) { servers = new Map(); clients.set(client, servers); }
    const metadata = mod.dispatch?.connection?.metadata || {};
    const key = [metadata.publisher, metadata.environment, metadata.serverId].join(':');
    if (!servers.has(key)) servers.set(key, { account: null, accountId: null, users: new Map(), nonce: Date.now() % 1000000000 });
    return servers.get(key);
}
module.exports = class ConsoleHUDNetwork {
    constructor(mod) {
        this.mod = mod; this.session = clientSession(mod);
        this.settings = null; this.scope = null; this.snapshots = {};
        this.pending = null; this.confirmed = null; this.lastRequest = null; this.confirmedNonce = null;
        this.restoreTimer = null; this.fromClientCache = false; this.activeHooks = [];
        this.sendingTheme = false;
        this.character = null; this.inLobby = false;
        this.received = { USER: { load: 0, save: 0 }, ACCOUNT: { load: 0, save: 0 } };
        this.mode = this.preferredMode();
        this.useAccountCache();
        for (const scope of ['USER', 'ACCOUNT']) {
            this.hookSettings('S_LOAD_CLIENT_' + scope + '_SETTING', event => {
                // Settings Saver/Fixer replace a blocked server packet with a
                // synthetic saved copy. Process that delivered copy as well.
                // Our own theme send is already patched and must pass once.
                if (this.sendingTheme) return;
                this.received[scope].load++;
                const incoming = Buffer.from(event.data);
                try {
                    codec.uiBlock(incoming);
                    this.snapshots[scope] = incoming;
                    this.selectScope(scope, false);
                    this.rememberSettings(scope);
                    if (mod.settings.enabled === false) return;
                    event.data = this.request(this.mode, incoming);
                    return true;
                } catch (error) {
                    // A controller packet without UI must not erase the
                    // account-wide UI captured on the previous connection.
                    try { codec.uiBlock(incoming); mod.error('HUD: ' + error.message); } catch (_) {}
                }
            });
            this.hookSettings('C_SAVE_CLIENT_' + scope + '_SETTING', event => {
                this.received[scope].save++;
                if (scope === 'USER' && this.inLobby) return;
                try {
                    this.capturePartyPreferences(event.data);
                    this.snapshots[scope] = codec.mergeSettings(this.snapshots[scope], event.data);
                    this.rememberSettings(scope);
                    if (!this.settings) {
                        // Some logins have no S_LOAD UI packet. A real UI save
                        // from this character can also establish the snapshot.
                        try {
                            codec.uiBlock(this.snapshots[scope]);
                            this.selectScope(scope, false);
                            this.scheduleRestore();
                        } catch (_) {}
                    }
                    if (scope === this.scope) this.settings = this.snapshots[scope];
                    let ack; try { ack = codec.controlValues(this.snapshots[scope]).CHLA; } catch (_) { return; }
                    if (this.lastRequest && ack === this.lastRequest.nonce && this.confirmedNonce !== ack) {
                        const request = this.lastRequest; this.clearPending();
                        this.confirmed = request.mode; this.confirmedNonce = ack;
                        mod.log('HUD theme acknowledged by GFx: ' + this.styleName(request.mode));
                    }
                } catch (error) { mod.error('HUD settings: ' + error.message); }

            });
        }
        this.commandHandler = (...args) => this.command(...args);
        this.registerCommands();
        mod.hook('S_RETURN_TO_LOBBY', 'event', () => this.leaveCharacter());
        mod.hook('S_LOGIN_ACCOUNT_INFO', 3, { order: 100000 }, event => {
            const accountId = String(event.accountId);
            if (this.session.accountId !== null && this.session.accountId !== accountId) {
                this.leaveCharacter();
                this.session.account = null; this.session.users.clear();
                this.snapshots = {}; this.settings = null; this.scope = null;
            }
            this.session.accountId = accountId;
        });
        mod.hook('S_LOGIN', mod.majorPatchVersion >= 114 ? 15 : 14, { order: 100000 }, event => {
            this.enterCharacter(event.playerId);
            this.mode = this.preferredMode();
            this.clearPending(); this.confirmed = null; this.confirmedNonce = null;
            this.registerCommands();
        });
        mod.hook('S_SPAWN_ME', 'event', { order: 100000 }, () => {
            this.registerCommands(); this.scheduleRestore();
        });
        this.partyInspect = new PartyInspect(this);
        mod.log('Console HUD network v' + version + ' ready: consolehud / chud; settings hooks ' + this.activeHooks.length + '/4.');
    }
    registerCommands() {
        // Register each alias independently, including after a character login.
        for (const name of ['consolehud', 'chud']) {
            if (this.commandsRegistered) this.mod.command.remove(name);
            this.mod.command.add(name, this.commandHandler);
        }
        this.commandsRegistered = true;
    }
    partyPreferences() {
        return { CHPH: this.mod.settings.partyHpPercent === true ? 1 : 0,
            CHBR: this.mod.settings.partyEffectsRight === true ? 1 : 0 };
    }
    capturePartyPreferences(data) {
        let values;
        try { values = codec.controlValues(data); } catch (_) { return; }
        let changed = false;
        for (const [key, setting] of [['CHPH', 'partyHpPercent'], ['CHBR', 'partyEffectsRight']]) {
            if (![0, 1].includes(values[key])) continue;
            const value = values[key] === 1;
            if (this.mod.settings[setting] !== value) { this.mod.settings[setting] = value; changed = true; }
        }
        if (changed) this.mod.saveSettings();
    }
    preferredMode() { return this.mod.settings.laurelStyle === 'default' ? 2 : ['console', 'round'].includes(this.mod.settings.laurelStyle) ? 0 : 1; }
    styleName(mode = this.mode) { return ['console', 'classic', 'default'][mode]; }
    styleLabel(mode = this.mode) { return ['консольный (создан нами)', 'классические венцы Lv65', 'штатный интерфейс 100.02'][mode]; }
    selectScope(scope, cached) {
        this.scope = scope; this.settings = this.snapshots[scope]; this.fromClientCache = cached;
    }
    useAccountCache() {
        if (!this.session.account) return;
        this.snapshots.ACCOUNT = Buffer.from(this.session.account);
        this.selectScope('ACCOUNT', true);
    }
    rememberSettings(scope) {
        try { codec.uiBlock(this.snapshots[scope]); }
        catch (_) { return; }
        if (scope === 'ACCOUNT') this.session.account = Buffer.from(this.snapshots.ACCOUNT);
        else if (this.character !== null && this.session.accountId !== null)
            this.session.users.set(this.character, Buffer.from(this.snapshots.USER));
    }
    enterCharacter(playerId) {
        const character = Number.isSafeInteger(playerId) && playerId > 0 ? String(playerId) : null;
        if (this.character !== null && this.character !== character) this.leaveCharacter();
        this.character = character; this.inLobby = false;
        if (this.snapshots.USER) {
            try { codec.uiBlock(this.snapshots.USER); this.selectScope('USER', false); this.rememberSettings('USER'); }
            catch (_) {}
        } else if (character !== null && this.session.accountId !== null && this.session.users.has(character)) {
            this.snapshots.USER = Buffer.from(this.session.users.get(character));
            this.selectScope('USER', true);
        }
    }
    scheduleRestore() {
        this.cancelRestore();
        this.restoreTimer = this.mod.setTimeout(() => {
            this.restoreTimer = null;
            if (this.settings && this.mod.settings.enabled !== false) try { this.sendTheme(this.mode); }
            catch (error) { this.mod.warn('HUD restore: ' + error.message); }
        }, 300);
    }
    cancelRestore() {
        if (this.restoreTimer !== null) this.mod.clearTimeout(this.restoreTimer);
        this.restoreTimer = null;
    }
    leaveCharacter() {
        this.cancelRestore(); this.clearPending();
        this.confirmed = null; this.confirmedNonce = null; this.lastRequest = null;
        // Never carry another character's USER settings into the next login.
        delete this.snapshots.USER; this.settings = null; this.scope = null;
        this.character = null; this.inLobby = true;
        this.useAccountCache();
    }
    hookSettings(name, handler) {
        try {
            const dispatch = this.mod.dispatch;
            if (dispatch && !dispatch.protocolMap.name.has(name)) throw new Error('Opcode is not mapped');
            if (dispatch && !dispatch.protocol.messages.get(name)?.has(1))
                dispatch.addDefinition(name, 1, path.join(__dirname, 'definitions', name + '.1.def'));
            this.mod.hook(name, 1, { order: 100000, filter: { fake: name.startsWith('S_LOAD_') ? null : false } }, handler);
            this.activeHooks.push(name);
        } catch (error) { this.mod.warn('HUD settings hook unavailable: ' + name + ': ' + error.message); }
    }
    clearPending() {
        if (this.pending) this.mod.clearTimeout(this.pending.timer);
        this.pending = null;
    }
    request(mode, settings = this.settings, controlsOnly = false) {
        this.session.nonce = this.session.nonce >= 2147483647 ? 1 : this.session.nonce + 1;
        const nonce = this.session.nonce, data = (controlsOnly ? codec.themePacket : codec.patchTheme)(settings, mode, nonce, this.partyPreferences());
        this.clearPending(); this.lastRequest = { mode, nonce };
        this.pending = { mode, nonce, timer: this.mod.setTimeout(() => { this.pending = null; }, 3000) };
        return data;
    }
    sendTheme(mode) {
        const data = this.request(mode, this.settings, true);
        this.sendingTheme = true;
        try {
            if (this.mod.send('S_LOAD_CLIENT_' + this.scope + '_SETTING', 1, { data }) === false)
                throw Error('Клиент не получил пакет настроек');
        } finally { this.sendingTheme = false; }
    }
    saveMode(mode) {
        this.mode = mode; this.mod.settings.laurelStyle = this.styleName(mode); this.mod.saveSettings();
    }
    command(argument, key, value) {
        const arg = String(argument || 'status').toLowerCase();
        if (arg === '_party') {
            const setting = { CHPH: 'partyHpPercent' }[key];
            if (setting && ['0', '1'].includes(value) && this.mod.settings[setting] !== (value === '1')) {
                this.mod.settings[setting] = value === '1'; this.mod.saveSettings();
            }
            return;
        }
        if (arg === 'status') {
            this.mod.command.message('v' + version + '. Мод ' + (this.mod.settings.enabled === false ? 'выключен' : 'включён') + '. Стиль: ' + this.styleLabel() + '. Ответ панели: ' + (this.lastRequest && this.confirmedNonce === this.lastRequest.nonce ? 'получен' : 'ещё не получен') + '. Хуки: ' + this.activeHooks.length + '/4; настройки: ' + (this.settings ? this.scope + (this.fromClientCache ? ' (сессия клиента)' : '') : 'ожидаются') + '. Пакеты LOAD/SAVE: USER ' + this.received.USER.load + '/' + this.received.USER.save + ', ACCOUNT ' + this.received.ACCOUNT.load + '/' + this.received.ACCOUNT.save + '.'); return;
        }
        if (arg === 'reload') {
            try {
                const enabled = this.mod.settings.enabled;
                this.mod.loadSettings(); this.mode = this.preferredMode(); this.cancelRestore();
                if (this.settings && this.mod.settings.enabled !== false) this.sendTheme(this.mode);
                this.mod.command.message('Настройки перечитаны: ' + this.styleName() + '.' +
                    (enabled !== this.mod.settings.enabled ? ' Для изменения enabled перезапусти клиент.' : ''));
            } catch (error) { this.mod.command.message('Не удалось перечитать настройки: ' + error.message); }
            return;
        }
        const mode = arg === 'default' ? 2 : ['classic', 'old'].includes(arg) ? 1 : ['console', 'round', 'new'].includes(arg) ? 0 : arg === 'toggle' ? (this.mode === 1 ? 0 : 1) : null;
        if (mode === null) { this.mod.command.message('Используй consolehud classic, consolehud console, consolehud default, consolehud toggle, consolehud status или consolehud reload.'); return; }
        this.cancelRestore();
        if (this.mod.settings.enabled === false) {
            this.saveMode(mode);
            this.mod.command.message('Режим сохранён. Мод выключен настройкой enabled; включение GPK требует перезапуска клиента.'); return;
        }
        if (!this.settings) {
            this.saveMode(mode);
            this.mod.command.message('Стиль сохранён; применится после загрузки настроек интерфейса.'); return;
        }
        try {
            this.sendTheme(mode); this.saveMode(mode);
            this.mod.command.message('Запрошен стиль: ' + this.styleLabel(mode) + '.');
        } catch (error) { this.clearPending(); this.mod.command.message('Переключение не выполнено: ' + error.message); }
    }
    destructor() {
        this.partyInspect.destructor();
        this.cancelRestore(); this.clearPending();
        for (const name of ['consolehud', 'chud']) this.mod.command.remove(name);
    }
};
