'use strict';
const codec = require('./settings-codec');
const RESOURCE_CLASSES = new Set([0, 1, 5, 8, 9, 10, 11, 12]);
const keyOf = member => member.serverId + ':' + member.playerId;
function encodeName(name) {
    let result = '';
    for (let i = 0; i < name.length; i++) result += name.charCodeAt(i).toString(16).padStart(4, '0');
    return result;
}

// Only numeric deltas cross the Toolbox -> GPK bridge. Window positions and
// preferences never travel in these packets. Drawing remains inside the GPK.
module.exports = class PartyResources {
    constructor(network) {
        this.network = network; this.mod = network.mod;
        this.members = new Map(); this.epoch = 1; this.timer = null;
        this.sent = new Map(); this.dirty = new Set(); this.removed = new Set();
        this.needsSnapshot = true; this.revision = 0; this.ownGameId = null;
        const hook = (name, version, fn) => {
            try { this.mod.hook(name, version, { order: 100000, filter: { fake: false } }, fn); }
            catch (error) { this.mod.warn('Party resource hook unavailable: ' + name + ': ' + error.message); }
        };
        for (const scope of ['USER', 'ACCOUNT']) {
            try {
                this.mod.hook('C_SAVE_CLIENT_' + scope + '_SETTING', 1,
                    { order: -100000, filter: { fake: false } }, event => {
                        const cleaned = codec.stripPartyResources(event.data);
                        if (cleaned) { event.data = cleaned; return true; }
                    });
            } catch (error) { this.mod.warn('Party resource save cleanup unavailable: ' + scope + ': ' + error.message); }
        }
        hook('S_LOGIN', this.mod.majorPatchVersion >= 114 ? 15 : 14, event => {
            this.reset(); this.ownGameId = event.gameId;
        });
        hook('S_PARTY_MEMBER_LIST', 8, event => this.setMembers(event.members));
        hook('S_PARTY_MEMBER_STAT_UPDATE', 3, event => this.update(event, event.curRe, event.maxRe));
        hook('S_PARTY_MEMBER_CHANGE_STAMINA', 2, event => this.update(event, event.currentRe, event.maxRe));
        hook('S_LEAVE_PARTY_MEMBER', 2, event => {
            const id = keyOf(event), member = this.members.get(id);
            if (!member) return;
            this.members.delete(id); this.dirty.delete(id); this.sent.delete(id);
            this.removed.add(member.controlKey); this.revision++; this.schedule();
        });
        hook('S_LEAVE_PARTY', 'event', () => this.reset());
        hook('S_RETURN_TO_LOBBY', 'event', () => this.reset());
    }
    reset() {
        if (this.timer !== null) this.mod.clearTimeout(this.timer);
        this.timer = null; this.members.clear(); this.sent.clear(); this.dirty.clear(); this.removed.clear();
        this.epoch++; this.revision++; this.needsSnapshot = true;
    }
    resync() {
        // A real native settings LOAD may recreate the panel. Ordinary style
        // commands only schedule outstanding deltas and do not request this.
        this.needsSnapshot = true; this.epoch++; this.revision++; this.schedule();
    }
    setMembers(members) {
        const next = new Map();
        for (const member of members || []) {
            if ((this.ownGameId != null && member.gameId === this.ownGameId) || !RESOURCE_CLASSES.has(member.class)) continue;
            if (typeof member.name !== 'string' || !member.name || member.name.length > 40) continue;
            const id = keyOf(member), old = this.members.get(id);
            const same = old && old.name === member.name && old.class === member.class;
            next.set(id, { ...member, controlKey: same ? old.controlKey : encodeName(member.name) + '_' + member.class,
                current: same ? old.current : 0, maximum: same ? old.maximum : 0 });
        }
        let changed = false;
        for (const [id, old] of this.members) {
            if (next.get(id)?.controlKey === old.controlKey) continue;
            this.removed.add(old.controlKey); this.dirty.delete(id); this.sent.delete(id); changed = true;
        }
        for (const [id, member] of next) {
            if (this.members.get(id)?.controlKey !== member.controlKey) { this.dirty.add(id); changed = true; }
            this.removed.delete(member.controlKey);
        }
        this.members = next;
        if (changed) this.revision++;
        if (changed || this.needsSnapshot || this.dirty.size || this.removed.size) this.schedule();
    }
    update(identity, current, maximum) {
        const id = keyOf(identity), member = this.members.get(id);
        if (!member || !Number.isInteger(current) || !Number.isInteger(maximum) || current < 0 || maximum < 0 || maximum > 2147483647) return;
        current = maximum > 0 ? Math.min(current, maximum) : 0;
        if (member.maximum !== maximum || member.current !== current) {
            member.maximum = maximum; member.current = current; this.revision++; this.dirty.add(id);
        }
        // An unchanged event can also retry a previous failed delivery.
        if (this.dirty.has(id)) this.schedule();
    }
    schedule() {
        if (this.timer !== null) return;
        this.timer = this.mod.setTimeout(() => { this.timer = null; this.flush(); }, 125);
    }
    flush(force = false) {
        const owner = this.network;
        if (!owner.settings || !owner.scope || owner.inLobby || owner.mode === 2 || this.mod.settings.enabled === false) return;
        const snapshot = force || this.needsSnapshot, entries = [], delivered = new Map();
        const epoch = this.epoch, revision = this.revision;
        if (snapshot) entries.push(['CHSTE', epoch]);
        else for (const key of this.removed) entries.push(['CHSTD_' + key, 1]);
        const ids = snapshot ? this.members.keys() : this.dirty;
        for (const id of ids) {
            const member = this.members.get(id); if (!member) continue;
            const previous = snapshot ? null : this.sent.get(id);
            if (!previous || previous.current !== member.current) entries.push(['CHSTC_' + member.controlKey, member.current]);
            if (!previous || previous.maximum !== member.maximum) entries.push(['CHSTM_' + member.controlKey, member.maximum]);
            delivered.set(id, { current: member.current, maximum: member.maximum });
        }
        if (!entries.length) { this.dirty.clear(); return; }
        try {
            const data = codec.partyResourcePacket(owner.settings, entries);
            owner.sendingTheme = true;
            if (this.mod.send('S_LOAD_CLIENT_' + owner.scope + '_SETTING', 1, { data }) === false)
                throw Error('Client rejected party resource packet');
            // Never mark failed or superseded state as delivered.
            if (epoch !== this.epoch) return;
            if (snapshot) this.sent.clear();
            for (const [id, value] of delivered) if (this.members.has(id)) this.sent.set(id, value);
            this.needsSnapshot = false;
            if (revision === this.revision) { this.dirty.clear(); this.removed.clear(); }
            else this.schedule();
        } catch (error) { this.mod.warn('Party resource delivery: ' + error.message); }
        finally { owner.sendingTheme = false; }
    }
    destructor() { this.reset(); }
};
