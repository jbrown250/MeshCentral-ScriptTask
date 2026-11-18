/**
* @description Minimal ZIP writer/reader for ScriptTask export/import (no external dependencies).
* Supports stored and deflated entries, UTF-8 names. No ZIP64 or encryption (not needed for scripts).
* @license Apache-2.0
*/

"use strict";
const zlib = require('zlib');

const CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    var c = -1;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function dosDateTime(d) {
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    var date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time, date: date };
}

// entries: [{ name: 'Shared/x.ps1', data: Buffer|string }]; names ending in '/' are folders.
function createZip(entries) {
    var locals = [], centrals = [], offset = 0;
    var dt = dosDateTime(new Date());
    entries.forEach(function (e) {
        var name = Buffer.from(e.name, 'utf8');
        var isDir = /\/$/.test(e.name);
        var raw = isDir ? Buffer.alloc(0) : (Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8'));
        var deflated = raw.length ? zlib.deflateRawSync(raw) : raw;
        var method = (deflated.length < raw.length) ? 8 : 0;
        var body = method ? deflated : raw;
        var crc = crc32(raw);

        var lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(dt.time, 10); lh.writeUInt16LE(dt.date, 12); lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
        locals.push(lh, name, body);

        var ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
        ch.writeUInt16LE(dt.time, 12); ch.writeUInt16LE(dt.date, 14); ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(isDir ? 0x10 : 0, 38); ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);
        offset += lh.length + name.length + body.length;
    });
    var cd = Buffer.concat(centrals);
    var end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat(locals.concat([cd, end]));
}

// Returns [{ name, isDir, data: Buffer }]. Throws on malformed/unsupported archives.
function readZip(buf, limits) {
    limits = limits || {};
    var maxEntries = limits.maxEntries || 10000, maxFile = limits.maxFileSize || 10 * 1024 * 1024, maxTotal = limits.maxTotal || 100 * 1024 * 1024;
    var eocd = -1;
    for (var i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file');
    var count = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) throw new Error('ZIP64 archives are not supported');
    if (count > maxEntries) throw new Error('Too many files in zip (' + count + ')');
    var out = [], p = cdOffset, total = 0;
    for (var n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
        var flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
        var csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
        var nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
        var lho = buf.readUInt32LE(p + 42);
        var nameBuf = buf.slice(p + 46, p + 46 + nlen);
        var name = nameBuf.toString((flags & 0x0800) ? 'utf8' : 'latin1').replace(/\\/g, '/');
        p += 46 + nlen + xlen + clen;
        var isDir = /\/$/.test(name);
        if (isDir) { out.push({ name: name, isDir: true, data: null }); continue; }
        if (flags & 0x1) { out.push({ name: name, isDir: false, data: null, error: 'encrypted' }); continue; }
        if (usize > maxFile) { out.push({ name: name, isDir: false, data: null, error: 'too large' }); continue; }
        total += usize; if (total > maxTotal) throw new Error('Zip contents too large');
        if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('Corrupt zip local header');
        var start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        var comp = buf.slice(start, start + csize);
        var data;
        if (method === 0) data = comp;
        else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: maxFile + 1 });
        else { out.push({ name: name, isDir: false, data: null, error: 'unsupported compression' }); continue; }
        if (data.length !== usize) throw new Error('Zip entry size mismatch: ' + name);
        out.push({ name: name, isDir: false, data: data });
    }
    return out;
}

module.exports = { createZip: createZip, readZip: readZip, crc32: crc32 };
