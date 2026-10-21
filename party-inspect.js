'use strict';
const identity = member => member.serverId + ':' + member.playerId;

module.exports = class PartyInspect {
    constructor(network) {
        this.network = network; this.mod = network.mod; this.members = new Map();
        // Native chat emits an immediate packet; saving UI preferences need not.
        // Channel 18 is Toolbox's local private command channel.
        this.mod.hook('C_CHAT', 1, { order: -100, filter: { fake: false } }, event => {
            if (event.channel !== 18) return;
            const message = event.message.replace(/<[^>]*>/g, '').trim();
            const prefix = 'consolehud _inspect ';
            if (!message.startsWith(prefix)) return;
            const encoded = message.slice(prefix.length);
            if (/^(?:[0-9a-f]{4}){1,40}$/.test(encoded)) {
                const name = encoded.match(/.{4}/g).map(code => String.fromCharCode(parseInt(code, 16))).join('');
                this.inspect(name);
            }
            // This internal action must never reach a chat recipient.
            return false;
        });
        const hook = (name, version, fn) => this.mod.hook(name, version,
            { order: 100000, filter: { fake: false } }, fn);
        hook('S_PARTY_MEMBER_LIST', 8, event => {
            this.members.clear();
            for (const member of event.members || []) {
                if (typeof member.name === 'string' && member.name.length > 0 && member.name.length <= 40)
                    this.members.set(identity(member), { name: member.name, serverId: member.serverId });
            }
        });
        hook('S_LEAVE_PARTY_MEMBER', 2, event => this.members.delete(identity(event)));
        for (const name of ['S_LEAVE_PARTY', 'S_RETURN_TO_LOBBY']) hook(name, 'event', () => this.members.clear());
        hook('S_LOGIN', this.mod.majorPatchVersion >= 114 ? 15 : 14, () => this.members.clear());
    }
    inspect(name) {
        if (this.mod.settings.enabled === false || this.network.inLobby) return;
        const targets = [...this.members.values()].filter(member => member.name === name);
        if (targets.length !== 1) return;
        try {
            const target = targets[0];
            const sent = this.mod.majorPatchVersion >= 108
                ? this.mod.send('C_REQUEST_USER_PAPERDOLL_INFO', 4, { name: target.name, serverId: target.serverId, zoom: false })
                : this.mod.send('C_REQUEST_USER_PAPERDOLL_INFO', 3, { name: target.name, zoom: false });
            if (sent === false) this.mod.warn('Party inspection request was blocked by another module.');
        } catch (error) { this.mod.warn('Party inspect: ' + error.message); }
    }
    destructor() { this.members.clear(); }
};
