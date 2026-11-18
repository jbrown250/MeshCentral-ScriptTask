/**
* @description MeshCentral ScriptTask plugin (agent side)
* @author Ryan Blenis
* @copyright
* @license Apache-2.0
*
* NOTE: This file runs inside the MeshAgent's Duktape engine. Keep it ES5:
* no arrow functions, no let, no template literals, no Promise-dependent code.
*
* Reliability notes (0.1.0):
*  - Jobs are de-duplicated by jobId. A job that is already running is never
*    started a second time, and a job that already finished simply has its
*    stored result re-sent to the server (covers lost "jobComplete" messages).
*  - Job state is persisted in the agent's SimpleDataStore so the de-duplication
*    survives agent restarts. If the agent restarts while a job is running
*    (e.g. the script itself restarts the agent or reboots the machine) the job
*    is reported as interrupted instead of being re-run in a loop.
*  - Temporary script/output files live in a dedicated "scripttask" sub-folder
*    and are always removed (each file independently). Leftover st*.ps1/.bat/
*    .sh/.txt files from older versions are swept from the agent folder.
*  - No longer modifies Array.prototype (which leaked into the whole meshcore).
*/

"use strict";
var mesh = null;
var db = require('SimpleDataStore').Shared();
var debug_flag = false;

var STATE_KEY = 'pluginScriptTask_jobState';
var SCRIPT_KEY_PREFIX = 'pluginScriptTask_script_';
var STATE_MAX_AGE = 14 * 86400;   // keep finished-job results for 14 days
var STATE_MAX_ENTRIES = 500;      // hard cap on remembered jobs
var SWEEP_INTERVAL = 3600;        // sweep leftover temp files at most hourly
var TEMP_FILE_RX = /^st[0-9a-v]{6,}\.(ps1|bat|sh|txt)$/;

var running = {};          // jobId -> { pid, files: [], started }
var pendingDownload = {};  // jobId -> jObj  (waiting for script from server)
var requestedScripts = {}; // scriptId -> epoch of last getScript request
var jobState = null;       // persisted: jobId -> { s: 'running'|'done', t, r, e, d, sid }
var lastSweep = 0;
var workDirCache = null;

function now() { return Math.floor(Date.now() / 1000); }

function dbg(str) {
    if (debug_flag !== true) return;
    try {
        var fs = require('fs');
        var logStream = fs.createWriteStream(joinPath(getWorkDir(), 'scripttask.txt'), { 'flags': 'a' });
        logStream.write('\n' + new Date().toLocaleString() + ': ' + str);
        logStream.end('\n');
    } catch (e) { }
}

/* ---------------------------------------------------------------- paths -- */

function sep() { return (process.platform == 'win32') ? '\\' : '/'; }
function joinPath(a, b) {
    if (a == null || a == '') return b;
    var s = sep();
    return (a.charAt(a.length - 1) == s) ? (a + b) : (a + s + b);
}
function dirName(p) {
    if (p == null) return null;
    var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return (i > 0) ? p.substring(0, i) : null;
}
function agentDir() {
    var d = null;
    try { d = dirName(process.execPath); } catch (e) { }
    if (d == null) { try { d = process.cwd(); } catch (e) { } }
    return d;
}

// A dedicated folder for temp files. Falls back to legacy locations if it can't be created.
function getWorkDir() {
    if (workDirCache != null) return workDirCache;
    var fs = require('fs');
    var candidates = [];
    var ad = agentDir();
    if (ad != null) candidates.push(joinPath(ad, 'scripttask'));
    if (process.platform == 'win32') {
        if (ad != null) candidates.push(ad);
    } else {
        candidates.push('/usr/local/mesh_services/meshagent/scripttask', '/usr/local/mesh/scripttask', '/var/tmp', '/tmp');
    }
    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        try {
            if (!fs.existsSync(c)) fs.mkdirSync(c);
            if (fs.existsSync(c)) { workDirCache = c; break; }
        } catch (e) { dbg('Could not use work dir ' + c + ': ' + e); }
    }
    if (workDirCache == null) workDirCache = (ad != null) ? ad : '.';
    dbg('Work dir is ' + workDirCache);
    return workDirCache;
}

function safeUnlink(f) {
    if (f == null) return;
    try { require('fs').unlinkSync(f); } catch (e) { dbg('Could not unlink ' + f + ': ' + e); }
}

function randName() { return 'st' + Math.random().toString(32).replace('0.', '') + Date.now().toString(32); }

// Remove temp files left behind by earlier versions / crashed runs.
function sweepStaleFiles(force) {
    var t = now();
    if (!force && (t - lastSweep) < SWEEP_INTERVAL) return;
    lastSweep = t;
    var fs = require('fs');
    var active = {};
    for (var j in running) { var fl = running[j].files || []; for (var k = 0; k < fl.length; k++) active[fl[k]] = true; }

    var dirs = [getWorkDir()];
    var ad = agentDir();
    if (ad != null && dirs.indexOf(ad) === -1) dirs.push(ad); // legacy location (pre 0.1.0 wrote here)
    if (process.platform != 'win32') {
        ['/usr/local/mesh', '/usr/local/mesh_services/meshagent'].forEach(function (d) { if (dirs.indexOf(d) === -1) dirs.push(d); });
    }
    var removed = 0;
    dirs.forEach(function (d) {
        var list = null;
        try { if (!fs.existsSync(d)) return; list = fs.readdirSync(d); } catch (e) { return; }
        if (list == null) return;
        for (var i = 0; i < list.length; i++) {
            var name = list[i];
            if (typeof name != 'string' || !TEMP_FILE_RX.test(name)) continue;
            var full = joinPath(d, name);
            if (active[full]) continue;
            try { fs.unlinkSync(full); removed++; } catch (e) { }
        }
    });
    if (removed) dbg('Swept ' + removed + ' leftover temp files');
}

/* ----------------------------------------------------------- job state -- */

function loadState() {
    if (jobState != null) return jobState;
    jobState = {};
    try {
        var raw = db.Get(STATE_KEY);
        if (raw != null && raw != '') jobState = (typeof raw == 'string') ? JSON.parse(raw) : raw;
        if (jobState == null || typeof jobState != 'object') jobState = {};
    } catch (e) { jobState = {}; }
    return jobState;
}
function saveState() {
    var st = loadState();
    // prune old / excess entries
    var t = now(), keys = [];
    for (var k in st) {
        if (st[k] == null || (st[k].s == 'done' && (t - (st[k].t || 0)) > STATE_MAX_AGE)) { delete st[k]; continue; }
        keys.push(k);
    }
    if (keys.length > STATE_MAX_ENTRIES) {
        keys.sort(function (a, b) { return (st[a].t || 0) - (st[b].t || 0); });
        for (var i = 0; i < keys.length - STATE_MAX_ENTRIES; i++) { if (running[keys[i]] == null) delete st[keys[i]]; }
    }
    try { db.Put(STATE_KEY, JSON.stringify(st)); } catch (e) { dbg('Could not persist job state: ' + e); }
}

/* ------------------------------------------------------- server comms -- */

function sendToServer(o) {
    if (mesh == null) { dbg('No mesh reference, cannot send ' + o.pluginaction); return; }
    o.action = 'plugin';
    o.plugin = 'scripttask';
    try { mesh.SendCommand(o); } catch (e) { dbg('SendCommand failed: ' + e); }
}

function reportComplete(jobId, scriptId, retVal, errVal, dispatchTime) {
    sendToServer({
        pluginaction: 'jobComplete',
        jobId: jobId,
        scriptId: scriptId,
        retVal: retVal,
        errVal: errVal,
        dispatchTime: dispatchTime
    });
}

function finalizeJob(job, retVal, errVal) {
    if (errVal != null && typeof errVal == 'object') errVal = (errVal.stack != null) ? errVal.stack : String(errVal);
    var r = running[job.jobId];
    if (r != null && r.files) r.files.forEach(safeUnlink);
    if (r != null) r.child = null;
    delete running[job.jobId];
    var st = loadState();
    st[job.jobId] = { s: 'done', t: now(), r: (retVal == null ? null : retVal), e: (errVal == null ? null : errVal), d: job.dispatchTime, sid: job.scriptId };
    saveState();
    reportComplete(job.jobId, job.scriptId, retVal, errVal, job.dispatchTime);
}

/* --------------------------------------------------------- entry point -- */

function consoleaction(args, rights, sessionid, parent) {
    if (typeof args['_'] == 'undefined') {
        args['_'] = [];
        args['_'][1] = args.pluginaction;
    }
    var fnname = args['_'][1];
    mesh = parent;
    loadState();

    switch (fnname) {
        case 'triggerJob':
            triggerJob({
                jobId: String(args.jobId),
                scriptId: args.scriptId,
                replaceVars: args.replaceVars,
                scriptHash: args.scriptHash,
                dispatchTime: args.dispatchTime
            });
            break;
        case 'cacheScript':
            onScriptReceived(args.script);
            break;
        case 'clearAll':
            clearCache();
            pendingDownload = {};
            requestedScripts = {};
            sendToServer({ pluginaction: 'clearAllPendingJobs' });
            return 'Cache cleared. All pending jobs cleared.';
        case 'clearCache':
            clearCache();
            return 'The script cache has been cleared';
        case 'clearState':
            jobState = {};
            saveState();
            return 'Remembered job state has been cleared';
        case 'cleanup':
            sweepStaleFiles(true);
            return 'Leftover temporary files removed from ' + getWorkDir();
        case 'debug':
            debug_flag = !debug_flag;
            return 'Debugging is now ' + (debug_flag ? 'on' : 'off') + ' (log: ' + joinPath(getWorkDir(), 'scripttask.txt') + ')';
        case 'getPendingJobs':
        case 'status':
            var out = [];
            for (var p in pendingDownload) out.push('Waiting for script: JobID ' + p + ' ScriptID ' + pendingDownload[p].scriptId);
            for (var r in running) out.push('Running: JobID ' + r + ' PID ' + running[r].pid + ' since ' + new Date(running[r].started * 1000).toLocaleString());
            return out.length ? out.join('\n') : 'No jobs running or pending script download';
        default:
            dbg('Unknown action: ' + fnname);
            break;
    }
}

function triggerJob(jObj) {
    sweepStaleFiles(false);
    var st = loadState();
    var prev = st[jObj.jobId];

    if (running[jObj.jobId] != null) { dbg('Job ' + jObj.jobId + ' already running. Ignoring duplicate dispatch.'); return; }
    if (pendingDownload[jObj.jobId] != null) { dbg('Job ' + jObj.jobId + ' already waiting for script. Ignoring duplicate dispatch.'); return; }

    if (prev != null && prev.s == 'done') {
        // Server didn't get our result (or re-sent). Re-report instead of running again.
        dbg('Job ' + jObj.jobId + ' already completed. Re-sending result.');
        reportComplete(jObj.jobId, prev.sid || jObj.scriptId, prev.r, prev.e, prev.d || jObj.dispatchTime);
        return;
    }
    if (prev != null && prev.s == 'running') {
        // We started this job before but the agent restarted before it finished.
        // Do NOT re-run it automatically - that is how restart/reboot scripts end up looping.
        dbg('Job ' + jObj.jobId + ' was interrupted by an agent restart. Not re-running.');
        finalizeJob(jObj, null, 'Job was interrupted (agent restarted or device rebooted while it was running). It was not re-run automatically.');
        return;
    }

    var sObj = getScriptFromCache(jObj.scriptId);
    if (sObj == null || sObj.contentHash != jObj.scriptHash) {
        pendingDownload[jObj.jobId] = jObj;
        var last = requestedScripts[jObj.scriptId] || 0;
        if ((now() - last) > 60) { // only one outstanding request per script
            requestedScripts[jObj.scriptId] = now();
            sendToServer({ pluginaction: 'getScript', scriptId: jObj.scriptId });
        }
        return;
    }
    runScript(sObj, jObj);
}

function onScriptReceived(sObj) {
    if (sObj == null || sObj._id == null) { dbg('Received empty script from server'); return; }
    var sid = String(sObj._id);
    delete requestedScripts[sid];
    cacheScript(sObj);
    var toRun = [];
    for (var j in pendingDownload) {
        var pd = pendingDownload[j];
        if (String(pd.scriptId) == sid) toRun.push(pd);
    }
    toRun.forEach(function (pd) {
        delete pendingDownload[pd.jobId];
        if (pd.scriptHash != sObj.contentHash) dbg('Script hash changed since job ' + pd.jobId + ' was dispatched; running current version.');
        runScript(sObj, pd);
    });
}

/* ------------------------------------------------------------- runner -- */

function applyVars(content, replaceVars) {
    if (replaceVars == null) return content;
    Object.getOwnPropertyNames(replaceVars).forEach(function (key) {
        var val = replaceVars[key];
        // split/join avoids regex-special characters in variable names/values breaking the replace
        content = content.split('#' + key + '#').join(val == null ? '' : String(val));
    });
    return content.replace(/#(.*?)#/g, 'VAR_NOT_FOUND');
}

function runScript(sObj, jObj) {
    if (running[jObj.jobId] != null) { dbg('Job ' + jObj.jobId + ' already running. Skipping.'); return; }

    // work on a copy so cached script / other jobs aren't affected by variable replacement
    var script = { _id: sObj._id, filetype: sObj.filetype, content: applyVars(String(sObj.content || ''), jObj.replaceVars) };

    running[jObj.jobId] = { pid: null, files: [], started: now(), job: jObj };
    var st = loadState();
    st[jObj.jobId] = { s: 'running', t: now(), d: jObj.dispatchTime, sid: jObj.scriptId };
    saveState();

    dbg('Running script ' + sObj._id + ' for job ' + jObj.jobId);
    try {
        switch (script.filetype) {
            case 'ps1': runPowerShell(script, jObj); break;
            case 'bat': runBat(script, jObj); break;
            case 'bash': runBash(script, jObj); break;
            default: finalizeJob(jObj, null, 'Unknown script type: ' + script.filetype); break;
        }
    } catch (e) {
        dbg('Error starting job: ' + e);
        finalizeJob(jObj, null, e);
    }
}

// Common completion handling for all script types.
function attachExit(child, jObj, outFile) {
    var errstr = '';
    var done = false;
    child.stderr.on('data', function (chunk) { errstr += chunk; });
    child.stdout.on('data', function (chunk) { }); // drain so the pipe can't fill up and block
    var entry = running[jObj.jobId];
    // Keep a strong reference to the child process object for as long as the job runs.
    // Without it the agent's garbage collector can finalize the child mid-run, which drops
    // the 'exit' event and can terminate the script (it then looks like it "disappeared").
    if (entry != null) { entry.pid = child.pid; entry.child = child; }
    child.on('exit', function (procRetVal, procRetSignal) {
        if (done) return;
        done = true;
        if (entry == null || running[jObj.jobId] !== entry) { dbg('Job ' + jObj.jobId + ' exit arrived for a job no longer tracked; ignoring.'); return; }
        dbg('Job ' + jObj.jobId + ' exited with ' + procRetVal + ', signal ' + procRetSignal);
        if (errstr != '') { finalizeJob(jObj, null, errstr); return; }
        if (procRetVal == 1) { finalizeJob(jObj, null, 'Process terminated unexpectedly.'); return; }
        var outstr = '';
        try { outstr = require('fs').readFileSync(outFile, 'utf8').toString(); } catch (e) { outstr = ''; }
        try { outstr = outstr.replace(/^﻿/, '').trim(); } catch (e) { }
        if (!outstr) outstr = procRetVal ? 'Failure' : 'Success';
        finalizeJob(jObj, outstr);
    });
}

function runPowerShell(sObj, jObj) {
    if (process.platform != 'win32') return runPowerShellNonWin(sObj, jObj);
    var fs = require('fs');
    var dir = getWorkDir(), base = randName();
    var pName = joinPath(dir, base + '.ps1'), oName = joinPath(dir, base + '.txt');
    running[jObj.jobId].files = [pName, oName];
    fs.writeFileSync(pName, sObj.content);
    var child = require('child_process').execFile(process.env['windir'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']);
    attachExit(child, jObj, oName);
    child.stdin.write("try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { }\r\n");
    child.stdin.write("& '" + pName.replace(/'/g, "''") + "' | Out-File -FilePath '" + oName.replace(/'/g, "''") + "' -Encoding UTF8\r\n");
    child.stdin.write('exit\r\n');
}

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function runPowerShellNonWin(sObj, jObj) {
    var fs = require('fs');
    var pwsh = '', pwsherr = '';
    try {
        var childp = require('child_process').execFile('/bin/sh', ['sh']);
        childp.stderr.on('data', function (chunk) { pwsherr += chunk; });
        childp.stdout.on('data', function (chunk) { pwsh += chunk; });
        childp.stdin.write('command -v pwsh\n');
        childp.stdin.write('exit\n');
        childp.waitExit();
    } catch (e) { finalizeJob(jObj, null, "Couldn't determine pwsh in env: " + e); return; }
    pwsh = pwsh.trim();
    if (pwsh == '') { finalizeJob(jObj, null, 'PowerShell is not installed' + (pwsherr ? (': ' + pwsherr) : '')); return; }

    var dir = getWorkDir(), base = randName();
    var pName = joinPath(dir, base + '.ps1'), oName = joinPath(dir, base + '.txt');
    running[jObj.jobId].files = [pName, oName];
    fs.writeFileSync(pName, sObj.content.split('\r\n').join('\n').split('\r').join('\n'));
    var child = require('child_process').execFile('/bin/sh', ['sh']);
    attachExit(child, jObj, oName);
    child.stdin.write(shQuote(pwsh) + ' -NoLogo -NoProfile -NonInteractive -File ' + shQuote(pName) + ' > ' + shQuote(oName) + '\n');
    child.stdin.write('exit\n');
}

function runBat(sObj, jObj) {
    if (process.platform != 'win32') { finalizeJob(jObj, null, 'Platform not supported.'); return; }
    var fs = require('fs');
    var dir = getWorkDir(), base = randName();
    var pName = joinPath(dir, base + '.bat'), oName = joinPath(dir, base + '.txt');
    running[jObj.jobId].files = [pName, oName];
    fs.writeFileSync(pName, sObj.content);
    var child = require('child_process').execFile(process.env['windir'] + '\\system32\\cmd.exe');
    attachExit(child, jObj, oName);
    child.stdin.write('"' + pName + '" > "' + oName + '"\r\n');
    child.stdin.write('exit\r\n');
}

function runBash(sObj, jObj) {
    if (process.platform == 'win32') { finalizeJob(jObj, null, 'Platform not supported.'); return; }
    var fs = require('fs');
    var dir = getWorkDir(), base = randName();
    var pName = joinPath(dir, base + '.sh'), oName = joinPath(dir, base + '.txt');
    running[jObj.jobId].files = [pName, oName];
    fs.writeFileSync(pName, sObj.content.split('\r\n').join('\n').split('\r').join('\n'));
    var child = require('child_process').execFile('/bin/sh', ['sh']);
    attachExit(child, jObj, oName);
    child.stdin.write('chmod 700 ' + shQuote(pName) + '\n');
    child.stdin.write(shQuote(pName) + ' > ' + shQuote(oName) + '\n');
    child.stdin.write('exit\n');
}

/* -------------------------------------------------------------- cache -- */

function getScriptFromCache(id) {
    var script = null;
    try { script = db.Get(SCRIPT_KEY_PREFIX + id); } catch (e) { return null; }
    if (script == '' || script == null) return null;
    if (typeof script == 'string') { try { script = JSON.parse(script); } catch (e) { return null; } }
    return script;
}
function cacheScript(sObj) {
    try { db.Put(SCRIPT_KEY_PREFIX + sObj._id, JSON.stringify(sObj)); } catch (e) { dbg('Could not cache script: ' + e); }
}
function clearCache() {
    db.Keys.forEach(function (k) {
        if (k.indexOf(SCRIPT_KEY_PREFIX) === 0) {
            db.Put(k, null);
            db.Delete(k);
        }
    });
}

module.exports = { consoleaction: consoleaction };
