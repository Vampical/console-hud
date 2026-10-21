'use strict';
// Preserve protobuf fields byte-for-byte, including fields unknown to this mod.
const zlib = require('zlib');
function varint(value) {
    value = BigInt(value); const bytes = [];
    do { let byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
    return Buffer.from(bytes);
}
function readVarint(data, cursor) {
    let result = 0n;
    for (let shift = 0n; shift < 70n && cursor.pos < data.length; shift += 7n) {
        const byte = data[cursor.pos++]; result |= BigInt(byte & 127) << shift;
        if (!(byte & 128)) return result;
    }
    throw Error('Invalid settings varint');
}
function fields(data) {
    if (!Buffer.isBuffer(data) || data.length > 8 * 1024 * 1024) throw Error('Invalid settings buffer');
    const result = [], cursor = { pos: 0 };
    while (cursor.pos < data.length) {
        const start = cursor.pos, tag = Number(readVarint(data, cursor)), id = tag >>> 3, wire = tag & 7;
        if (!id) throw Error('Invalid settings field');
        let value;
        if (wire === 0) value = readVarint(data, cursor);
        else if (wire === 2) {
            const length = Number(readVarint(data, cursor));
            if (!Number.isSafeInteger(length) || length < 0 || length > data.length - cursor.pos) throw Error('Truncated settings field');
            value = data.subarray(cursor.pos, cursor.pos + length); cursor.pos += length;
        } else if (wire === 1 || wire === 5) cursor.pos += wire === 1 ? 8 : 4;
        else throw Error('Unsupported settings wire type');
        if (cursor.pos > data.length) throw Error('Truncated settings scalar');
        result.push({ id, wire, value, raw: data.subarray(start, cursor.pos) });
    }
    return result;
}
const bytes = (id, value) => Buffer.concat([varint(id * 8 + 2), varint(value.length), value]);
const integer = (id, value) => Buffer.concat([varint(id * 8), varint(value)]);
const text = data => data.toString('utf16le').replace(/\0+$/, '');
const find = (list, id) => list.find(field => field.id === id);
function replace(list, replacements) {
    const remaining = new Map(replacements), result = [];
    for (const field of list) {
        if (remaining.has(field.id)) { result.push(remaining.get(field.id)); remaining.delete(field.id); }
        else if (!replacements.has(field.id)) result.push(field.raw);
    }
    result.push(...remaining.values()); return Buffer.concat(result);
}
function blockName(block) { const name = find(fields(block), 10); return name && name.wire === 2 ? text(name.value) : null; }
function uiBlock(data) {
    const outer = fields(data), block = outer.find(field => field.id === 10 && field.wire === 2 && blockName(field.value) === 'S1UI_GFxManager');
    if (!block) throw Error('S1UI_GFxManager is missing in captured client settings');
    const header = fields(block.value), body = find(header, 20), compressed = find(header, 30);
    if (!body || body.wire !== 2) throw Error('UI settings payload is missing');
    const decoded = compressed && compressed.value !== 0n ? zlib.inflateSync(body.value, { maxOutputLength: 8 * 1024 * 1024 }) : body.value;
    return { outer, block, header, decoded, compressed: !!(compressed && compressed.value !== 0n) };
}
function controlValues(data) {
    const result = {};
    for (const field of fields(uiBlock(data).decoded)) {
        if (field.id !== 2 || field.wire !== 2) continue;
        const entry = fields(field.value), key = find(entry, 1), value = find(entry, 2);
        if (key && value && key.wire === 2 && value.wire === 2) {
            const name = text(key.value);
            if (['CHLS', 'CHLR', 'CHLA', 'CHPH', 'CHBR'].includes(name)) result[name] = Number(text(value.value));
        }
    }
    return result;
}
function patchTheme(data, mode, nonce, party) {
    const controls = [['CHLS', mode], ['CHLR', nonce]];
    if (party) for (const key of ['CHPH', 'CHBR']) {
        if (![0, 1].includes(party[key])) throw Error('Invalid party preference: ' + key);
        controls.push([key, party[key]]);
    }
    const replacedKeys = controls.map(([key]) => key);
    if (![0, 1, 2].includes(mode) || !Number.isInteger(nonce) || nonce < 0 || nonce > 2147483647) throw Error('Invalid HUD theme request');
    const ui = uiBlock(data), kept = fields(ui.decoded).filter(field => {
        if (field.id !== 2 || field.wire !== 2) return true;
        const key = find(fields(field.value), 1);
        return !key || key.wire !== 2 || !replacedKeys.includes(text(key.value));
    }).map(field => field.raw);
    for (const [key, value] of controls)
        kept.push(bytes(2, Buffer.concat([bytes(1, Buffer.from(key, 'utf16le')), bytes(2, Buffer.from(String(value), 'utf16le'))])));
    const decoded = Buffer.concat(kept), encoded = ui.compressed ? zlib.deflateSync(decoded) : decoded;
    const newBlock = replace(ui.header, new Map([[20, bytes(20, encoded)], [40, integer(40, decoded.length)]]));
    return Buffer.concat(ui.outer.map(field => field === ui.block ? bytes(10, newBlock) : field.raw));
}
function mergeSettings(base, update) {
    if (!base) return Buffer.from(update);
    const old = fields(base), newer = fields(update), byName = new Map();
    for (const field of newer) if (field.id === 10 && field.wire === 2) {
        const name = blockName(field.value); if (!name) throw Error('Settings controller has no name');
        byName.set(name, field.raw);
    }
    const output = old.map(field => {
        const name = field.id === 10 && field.wire === 2 ? blockName(field.value) : null;
        if (!byName.has(name)) return field.raw;
        let result = byName.get(name); byName.delete(name);
        if (name === 'S1UI_GFxManager') result = mergeUI(field.raw, result);
        return result;
    });
    output.push(...byName.values()); return Buffer.concat(output);
}
function themePacket(data, mode, nonce, party) {
    // A synthetic LOAD is a partial update, not a replay of cached client UI.
    // Keep required packet/controller metadata but emit only our own controls.
    const ui = uiBlock(patchTheme(data, mode, nonce, party));
    const keys = new Set(['CHLS', 'CHLR', 'CHPH', 'CHBR']);
    const decoded = Buffer.concat(fields(ui.decoded).filter(field => {
        if (field.id !== 2 || field.wire !== 2) return false;
        const key = find(fields(field.value), 1);
        return key && key.wire === 2 && keys.has(text(key.value));
    }).map(field => field.raw));
    const encoded = ui.compressed ? zlib.deflateSync(decoded) : decoded;
    const metadata = ui.header.filter(field => [1, 10, 20, 30, 40].includes(field.id));
    const header = replace(metadata, new Map([[20, bytes(20, encoded)], [40, integer(40, decoded.length)]]));
    return Buffer.concat([
        ...ui.outer.filter(field => field.id !== 10).map(field => field.raw),
        bytes(10, header)
    ]);
}
function mergeUI(base, update) {
    const old = uiBlock(base), incoming = uiBlock(update), changes = fields(incoming.decoded), pending = new Map();
    const keyOf = field => {
        if ((field.id === 1 || field.id === 2) && field.wire === 2) {
            const name = find(fields(field.value), 1);
            if (name && name.wire === 2) return field.id + ':' + text(name.value);
        }
        return 'field:' + field.id;
    };
    for (const field of changes) pending.set(keyOf(field), field.raw);
    const output = fields(old.decoded).map(field => {
        const key = keyOf(field); if (!pending.has(key)) return field.raw;
        const result = pending.get(key); pending.delete(key); return result;
    });
    output.push(...pending.values());
    const decoded = Buffer.concat(output), encoded = old.compressed ? zlib.deflateSync(decoded) : decoded;
    return bytes(10, replace(old.header, new Map([[20, bytes(20, encoded)], [40, integer(40, decoded.length)]])));
}
module.exports = { fields, bytes, integer, text, uiBlock, controlValues, patchTheme, themePacket, mergeSettings };
