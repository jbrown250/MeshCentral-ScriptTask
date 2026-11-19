/** 
* @description MeshCentral ScriptTask
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";

// MeshCentral's in-place plugin upgrade (My Server > Plugins > Upgrade) unpacks the new files and then
// require()s this file again. Node would hand back the cached old code, so drop this plugin's files
// from the module cache now; the next require() after an upgrade then loads the new version.
(function () {
    ['scripttask.js', 'db.js', 'nemongo.js', 'zip.js'].forEach(function (f) {
        try { delete require.cache[require.resolve(require('path').join(__dirname, f))]; } catch (e) { }
    });
})();

module.exports.scripttask = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.db = null;
    obj.intervalTimer = null;
    obj.debug = obj.meshServer.debug;
    obj.VIEWS = __dirname + '/views/';
    obj.exports = [      
        'onDeviceRefreshEnd',
        'resizeContent',
        'historyData',
        'variableData',
        'malix_triggerOption'
    ];
    
    obj.malix_triggerOption = function(selectElem) {
        selectElem.options.add(new Option("ScriptTask - Run Script", "scripttask_runscript"));
    }
    obj.malix_triggerFields_scripttask_runscript = function() {
        
    }
    obj.resetQueueTimer = function() {
        // The timer handle is kept on the pluginHandler (not just this instance) so that an in-place
        // upgrade from My Server > Plugins, which loads a new instance without restarting, stops the
        // old instance's timer instead of leaving two queue runners going.
        var ph = obj.meshServer.pluginHandler;
        if (ph._scripttaskTimer != null) clearInterval(ph._scripttaskTimer);
        if (obj.intervalTimer != null) clearInterval(obj.intervalTimer);
        obj.intervalTimer = setInterval(obj.queueRun, 1 * 60 * 1000); // every minute
        ph._scripttaskTimer = obj.intervalTimer;
    };

    // In-memory record of which agent connection each job was last sent to.
    // jobId -> { agent: <agent connection object>, time: <epoch seconds> }
    obj.dispatched = {};
    // Re-send an unfinished job to the SAME agent connection only after this long.
    // The agent ignores duplicates of running jobs and re-reports finished ones,
    // so this only exists to recover from a lost jobComplete message.
    obj.REDISPATCH_SAME_CONNECTION_SECS = 15 * 60;
    obj.queueRunning = false;
    obj.queueRunAgain = false;

    // Render plugin views without Express's view cache so an upgrade shows the new pages immediately.
    obj.noCache = function(vars) { vars = vars || {}; vars.cache = false; return vars; };

    // ---- Authorization ---------------------------------------------------------------------------
    // MeshCentral passes every 'plugin' command to serveraction() after only checking that the sender
    // is logged in (users) or connected (agents). The plugin must enforce permissions itself.
    //  - Everything ScriptTask does requires a full MeshCentral administrator.
    //  - Running/scheduling on a device additionally requires the "remote command" right on it.
    //  - Agents may only fetch scripts they have a pending job for, report results, and clear their own queue.
    obj.SITERIGHT_ADMIN = 0xFFFFFFFF;
    obj.MESHRIGHT_REMOTECOMMAND = 0x00020000;
    obj.AGENT_ACTIONS = { getScript: true, jobComplete: true, clearAllPendingJobs: true };
    obj.isAdmin = function(user) { return (user != null) && (typeof user.siteadmin == 'number') && ((user.siteadmin >>> 0) === obj.SITERIGHT_ADMIN); };
    obj.adminTargets = function() {
        var users = (obj.meshServer.webserver && obj.meshServer.webserver.users) || {};
        var ids = Object.keys(users).filter(id => obj.isAdmin(users[id]));
        return ids.length ? ids : ['scripttask-no-admins-online'];
    };
    obj.canRunOn = function(myparent, nodeid) {
        return new Promise(resolve => {
            var ws = obj.meshServer.webserver;
            if (typeof nodeid != 'string' || ws == null || typeof ws.GetNodeWithRights != 'function') return resolve(false);
            try {
                ws.GetNodeWithRights(myparent.domain, myparent.user, nodeid, function(node, rights) {
                    resolve(node != null && (((rights >>> 0) === 0xFFFFFFFF) || ((rights & obj.MESHRIGHT_REMOTECOMMAND) != 0)));
                });
            } catch (e) { resolve(false); }
        });
    };
    obj.allowedNodes = async function(myparent, nodes) {
        var list = Array.isArray(nodes) ? nodes : (nodes != null ? [nodes] : []);
        var ok = [];
        for (const n of list) {
            if (await obj.canRunOn(myparent, n)) ok.push(n);
            else console.log('PLUGIN: ScriptTask: ' + myparent.user._id + ' lacks remote command rights on ' + n + '; not queued.');
        }
        return ok;
    };

    obj.server_startup = function() {
        obj.meshServer.pluginHandler.scripttask_db = require (__dirname + '/db.js').CreateDB(obj.meshServer);
        obj.db = obj.meshServer.pluginHandler.scripttask_db;
        obj.resetQueueTimer();
    };
    
    obj.onDeviceRefreshEnd = function() {
        if (typeof userinfo == 'undefined' || userinfo == null || ((userinfo.siteadmin >>> 0) !== 0xFFFFFFFF)) return; // administrators only
        pluginHandler.registerPluginTab({
            tabTitle: 'ScriptTask',
            tabId: 'pluginScriptTask'
        });
        QA('pluginScriptTask', '<iframe id="pluginIframeScriptTask" style="width: 100%; height: 600px; border: 0; display: block" frameBorder=0 src="/pluginadmin.ashx?pin=scripttask&user=1" />');
        if (!window.scriptTaskResizeHooked) {
            window.scriptTaskResizeHooked = true;
            window.addEventListener('resize', function() { pluginHandler.scripttask.resizeContent(); });
        }
        setTimeout(function() { pluginHandler.scripttask.resizeContent(); }, 100);
    };
    // Size the iframe to fill the rest of the browser window (below where the tab content starts).
    obj.resizeContent = function() {
        var iFrame = document.getElementById('pluginIframeScriptTask');
        if (iFrame == null) return;
        var top = iFrame.getBoundingClientRect().top;
        if (top <= 0) return; // tab not visible yet; the iframe calls this again when it is shown
        var newHeight = Math.max(400, Math.floor(window.innerHeight - top - 12));
        if (Math.abs(iFrame.offsetHeight - newHeight) > 2) iFrame.style.height = newHeight + 'px';
    };
    
    obj.queueRun = async function() {
        // Never let two queue runs overlap - overlapping runs were sending the same job twice.
        if (obj.db == null || obj.db.scriptFile == null) return; // database not ready yet
        if (obj.queueRunning) { obj.queueRunAgain = true; return; }
        obj.queueRunning = true;
        try {
            do {
                obj.queueRunAgain = false;
                await obj.dispatchPendingJobs();
                await obj.makeJobsFromSchedules();
                obj.cleanHistory();
            } while (obj.queueRunAgain);
        } catch (e) {
            console.log('PLUGIN: ScriptTask: Queue Run Error: ', e);
        } finally {
            obj.queueRunning = false;
        }
    };

    obj.shouldDispatch = function(job, agent, nowTime) {
        var d = obj.dispatched[String(job._id)];
        if (d == null) {
            // No in-memory record (first send, or the server restarted). If it was sent very
            // recently, wait for the redispatch window; the agent dedupes anyway.
            if (job.dispatchTime != null && (nowTime - job.dispatchTime) < 60) return false;
            return true;
        }
        if (d.agent !== agent) return true; // agent reconnected since we sent it - its copy may be gone
        return (nowTime - d.time) >= obj.REDISPATCH_SAME_CONNECTION_SECS;
    };

    obj.dispatchPendingJobs = async function() {
        var wsagents = obj.meshServer.webserver.wsagents;
        var onlineAgents = Object.keys(wsagents);
        if (onlineAgents.length == 0) return;
        var jobs = await obj.db.getPendingJobs(onlineAgents);
        if (!jobs || jobs.length == 0) return;

        var nowTime = Math.floor(new Date() / 1000);
        var scriptCache = {};
        for (const job of jobs) {
            var agent = wsagents[job.node];
            if (agent == null) continue;
            if (!obj.shouldDispatch(job, agent, nowTime)) continue;
            try {
                var sid = String(job.scriptId);
                if (!(sid in scriptCache)) { var found = await obj.db.get(job.scriptId); scriptCache[sid] = found[0] || null; }
                var script = scriptCache[sid];
                if (script == null) {
                    // script was deleted - close the job out instead of retrying forever
                    await obj.db.update(job._id, { dispatchTime: nowTime, completeTime: nowTime, errorVal: 'Script no longer exists' });
                    delete obj.dispatched[String(job._id)];
                    continue;
                }
                var replaceVars = await obj.buildReplaceVars(script, job, agent);
                var dispatchTime = job.dispatchTime || nowTime; // keep the original dispatch time on re-sends
                // record BEFORE sending so a concurrent path can't send it again
                obj.dispatched[String(job._id)] = { agent: agent, time: nowTime };
                agent.send(JSON.stringify({
                    action: 'plugin',
                    plugin: 'scripttask',
                    pluginaction: 'triggerJob',
                    jobId: String(job._id),
                    scriptId: String(job.scriptId),
                    replaceVars: replaceVars,
                    scriptHash: script.contentHash,
                    dispatchTime: dispatchTime
                }));
                if (job.dispatchTime == null) {
                    await obj.db.update(job._id, { dispatchTime: dispatchTime });
                    obj.updateFrontEnd({ scriptId: job.scriptId, nodeId: job.node });
                }
            } catch (e) {
                console.log('PLUGIN: ScriptTask: Could not dispatch job.', e);
            }
        }
    };

    obj.buildReplaceVars = async function(script, job, agent) {
        var replaceVars = {};
        var foundVars = (script.content || '').match(/#(.*?)#/g);
        if (foundVars == null || foundVars.length == 0) return replaceVars;
        var foundVarNames = foundVars.map(fv => fv.replace(/^#+|#+$/g, ''));
        var meshId = agent ? agent.dbMeshKey : null;
        var finvals = await obj.db.getVariables({
            scriptId: String(job.scriptId),
            nodeId: job.node,
            meshId: meshId,
            names: foundVarNames
        });
        var ordering = { 'global': 0, 'script': 1, 'mesh': 2, 'node': 3 };
        finvals.sort((a, b) => (ordering[a.scope] - ordering[b.scope]) || a.name.localeCompare(b.name));
        finvals.forEach(fv => { replaceVars[fv.name] = fv.value; });
        replaceVars['GBL:meshId'] = meshId;
        replaceVars['GBL:nodeId'] = job.node;
        replaceVars['GBL:runBy'] = job.runBy || 'unknown';
        return replaceVars;
    };

    obj.cleanHistory = function() {
        var nowTime = Math.floor(new Date() / 1000);
        if (obj.lastHistoryClean != null && (nowTime - obj.lastHistoryClean) < 6 * 3600) return;
        obj.lastHistoryClean = nowTime;
        obj.db.deleteOldHistory().catch(e => { console.log('PLUGIN: ScriptTask: History cleanup failed: ', e); });
        // forget dispatch records for jobs that no longer exist / are long gone
        for (var k in obj.dispatched) { if ((nowTime - obj.dispatched[k].time) > 7 * 86400) delete obj.dispatched[k]; }
    };
    
    obj.downloadFile = function(req, res, user) {
        var id = req.query.dl;
        obj.db.get(id)
        .then(found => {
          if (found.length != 1) { res.sendStatus(401); return; }
          var file = found[0];
          res.setHeader('Content-disposition', 'attachment; filename=' + file.name);
          res.setHeader('Content-type', 'text/plain');
          //var fs = require('fs');
          res.send(file.content);
        });
    };
    
    obj.updateFrontEnd = async function(ids){
        if (ids.scriptId != null) {
            var scriptHistory = null;
            obj.db.getJobScriptHistory(ids.scriptId)
            .then((sh) => {
                scriptHistory = sh;
                return obj.db.getJobSchedulesForScript(ids.scriptId);
            })
            .then((scriptSchedule) => {
                var targets = obj.adminTargets();
                obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'historyData', scriptId: ids.scriptId, nodeId: null, scriptHistory: scriptHistory, nodeHistory: null, scriptSchedule: scriptSchedule });
            });
        }
        if (ids.nodeId != null) {
            var nodeHistory = null;
            obj.db.getJobNodeHistory(ids.nodeId)
            .then((nh) => {
                nodeHistory = nh;
                return obj.db.getJobSchedulesForNode(ids.nodeId);
            })
            .then((nodeSchedule) => {
                var targets = obj.adminTargets();
                obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'historyData', scriptId: null, nodeId: ids.nodeId, scriptHistory: null, nodeHistory: nodeHistory, nodeSchedule: nodeSchedule });
            });
        }
        if (ids.tree === true) {
            obj.db.getScriptTree()
            .then((tree) => {
                var targets = obj.adminTargets();
                obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'newScriptTree', tree: tree });
            });
        }
        if (ids.variables === true) {
            obj.db.getVariables()
            .then((vars) => {
                var targets = obj.adminTargets();
                obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'variableData', vars: vars });
            });
        }
    };
    
    obj.handleAdminReq = function(req, res, user) {
        if (req.query.include == 1) return obj.sendInclude(req, res); // static CSS/JS for the date picker only
        if (!obj.isAdmin(user)) { res.sendStatus(401); return; }      // everything else: full administrators only
        if (req.query.admin == 1) {
            res.render(obj.VIEWS + 'admin', obj.noCache({}));
            return;
        } else if (req.query.user == 1) { 
            if (req.query.dl != null) return obj.downloadFile(req, res, user);
            var vars = {};
            
            if (req.query.edit == 1) { // edit script
                if (req.query.id == null) return res.sendStatus(401); 
                obj.db.get(req.query.id)
                .then((scripts) => {
                    if (scripts[0].filetype == 'proc') {
                        vars.procData = JSON.stringify(scripts[0]);
                        res.render(obj.VIEWS + 'procedit', obj.noCache(vars));
                    } else {
                        vars.scriptData = JSON.stringify(scripts[0]);
                        res.render(obj.VIEWS + 'scriptedit', obj.noCache(vars));
                    }
                });
                return;
            } else if (req.query.schedule == 1) {
                var vars = {};
                res.render(obj.VIEWS + 'schedule', obj.noCache(vars));
                return;
            }
            if (req.query.export == 1) return obj.exportScripts(req, res);
            // default user view (tree)
            vars.scriptTree = 'null';
            obj.db.getScriptTree()
            .then(tree => {
              vars.scriptTree = JSON.stringify(tree);
              res.render(obj.VIEWS + 'user', obj.noCache(vars));
            });
            return;
        }
        res.sendStatus(401); 
        return;
    };

    obj.sendInclude = function(req, res) {
        var rel = String(req.query.path || '');
        // only plain files under includes/, no traversal
        if (!/^[A-Za-z0-9._\/-]+$/.test(rel) || rel.split('/').some(p => p == '..' || p == '')) { res.sendStatus(404); return; }
        var ext = rel.split('.').pop().toLowerCase();
        if (ext == 'css') res.contentType('text/css'); else if (ext == 'js') res.contentType('text/javascript'); else { res.sendStatus(404); return; }
        res.sendFile(__dirname + '/includes/' + rel);
    };
    
    // ---- Export / import -----------------------------------------------------------------------
    // Export: a zip whose folders mirror the script tree, one plain .ps1/.bat/.sh file per script,
    // plus scripttask-export.json recording ids, real names and ordering so a re-import updates
    // the same scripts. Import: updates scripts that match (by id, then folder + name), creates
    // new ones and missing folders, and never deletes anything.
    obj.EXPORT_MANIFEST = 'scripttask-export.json';
    obj.EXT_BY_TYPE = { ps1: '.ps1', bat: '.bat', bash: '.sh' };
    obj.TYPE_BY_EXT = { '.ps1': 'ps1', '.bat': 'bat', '.cmd': 'bat', '.sh': 'bash', '.bash': 'bash' };

    obj.safeFileName = function (n) {
        var r = String(n == null ? '' : n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
        if (r == '' || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(r)) r = '_' + r;
        return r;
    };

    obj.buildExport = async function () {
        var items = await obj.db.scriptFile.find({ type: { $in: ['script', 'folder'] } }).toArray();
        var folders = items.filter(i => i.type == 'folder').sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
        var zipDirOf = {}, usedNames = {};
        var unique = function (dir, base, ext) {
            var key = (dir + '/' + base + ext).toLowerCase(), n = 2, cand = base;
            while (usedNames[(dir + '/' + cand + ext).toLowerCase()]) cand = base + ' (' + (n++) + ')';
            usedNames[(dir + '/' + cand + ext).toLowerCase()] = true;
            return cand + ext;
        };
        var manifest = { format: 'meshcentral-scripttask', version: 1, exported: new Date().toISOString(), folders: [], scripts: [] };
        var entries = [];
        folders.forEach(f => {
            var parentPath = f.path.indexOf('/') > 0 ? f.path.substring(0, f.path.lastIndexOf('/')) : null;
            var parentDir = (parentPath != null) ? (zipDirOf[parentPath] || obj.safeFileName(parentPath)) : '';
            var seg = obj.safeFileName(f.path.substring(f.path.lastIndexOf('/') + 1));
            var dir = parentDir ? (parentDir + '/' + unique(parentDir, seg, '')) : unique('', seg, '');
            zipDirOf[f.path] = dir;
            entries.push({ name: dir + '/' });
            manifest.folders.push({ dir: dir, path: f.path, id: String(f._id), sortOrder: (typeof f.sortOrder == 'number') ? f.sortOrder : null });
        });
        items.filter(i => i.type == 'script').forEach(sc => {
            var dir = zipDirOf[sc.path] || zipDirOf['Shared'] || 'Shared';
            var file = dir + '/' + unique(dir, obj.safeFileName(sc.name), obj.EXT_BY_TYPE[sc.filetype] || '.txt');
            entries.push({ name: file, data: sc.content || '' });
            manifest.scripts.push({ file: file, id: String(sc._id), name: sc.name, filetype: sc.filetype, path: sc.path, hash: sc.contentHash || null, sortOrder: (typeof sc.sortOrder == 'number') ? sc.sortOrder : null });
        });
        entries.unshift({ name: obj.EXPORT_MANIFEST, data: JSON.stringify(manifest, null, 2) });
        return { zip: require(__dirname + '/zip.js').createZip(entries), count: manifest.scripts.length };
    };

    obj.exportScripts = function (req, res) {
        obj.buildExport()
        .then(r => {
            var d = new Date(), pad = n => String(n).padStart(2, '0');
            var fname = 'scripttask-export-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.zip';
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
            res.setHeader('Cache-Control', 'no-store');
            res.send(r.zip);
        })
        .catch(e => { console.log('PLUGIN: ScriptTask: Export failed: ', e); res.sendStatus(500); });
    };

    // apply=false is a dry run: nothing is written, the result describes what would happen.
    obj.importZip = async function (buf, apply) {
        var result = { created: [], updated: [], unchanged: 0, foldersCreated: [], skipped: [], conflicts: [], applied: !!apply };
        var plan = []; // what would be touched and the server state it was based on -> result.token
        var entries = require(__dirname + '/zip.js').readZip(buf, { maxEntries: 2000, maxFileSize: 2 * 1024 * 1024, maxTotal: 20 * 1024 * 1024 });
        // normalise paths; drop anything trying to escape with ".."
        entries = entries.filter(e => {
            e.name = e.name.replace(/^\/+/, '');
            if (e.name.split('/').some(seg => seg == '..')) { result.skipped.push(e.name + ' (invalid path)'); return false; }
            return e.name != '' && !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(e.name);
        });
        // If the zip was re-packed with an extra wrapper folder (e.g. "export/Shared/..."), strip it.
        var firstSegs = {};
        entries.forEach(e => { firstSegs[e.name.split('/')[0]] = true; });
        var segs = Object.keys(firstSegs);
        if (!firstSegs['Shared'] && !firstSegs[obj.EXPORT_MANIFEST] && segs.length == 1 && entries.every(e => e.name.indexOf('/') > 0)) {
            var wrap = segs[0] + '/';
            entries.forEach(e => { e.name = e.name.substring(wrap.length); });
            entries = entries.filter(e => e.name != '');
        }

        var manifest = { folders: [], scripts: [] };
        var mEntry = entries.find(e => e.name == obj.EXPORT_MANIFEST);
        if (mEntry && mEntry.data) {
            try { var m = JSON.parse(mEntry.data.toString('utf8')); if (m && Array.isArray(m.scripts)) manifest = { folders: m.folders || [], scripts: m.scripts }; }
            catch (e) { result.skipped.push(obj.EXPORT_MANIFEST + ' (unreadable, matching by folder and name instead)'); }
        }
        var mScriptByFile = {}, mFolderByDir = {};
        manifest.scripts.forEach(ms => { if (ms && ms.file) mScriptByFile[String(ms.file).toLowerCase()] = ms; });
        manifest.folders.forEach(mf => { if (mf && mf.dir) mFolderByDir[String(mf.dir).toLowerCase()] = mf; });

        var all = await obj.db.scriptFile.find({ type: { $in: ['script', 'folder'] } }).toArray();
        var folderByPath = {};
        all.filter(d => d.type == 'folder').forEach(f => { folderByPath[f.path.toLowerCase()] = f; });
        var scriptById = {};
        all.filter(d => d.type == 'script').forEach(sc => { scriptById[String(sc._id)] = sc; });

        // zip folder -> tree path (manifest knows the real names; otherwise the folder names are used)
        var treePathOf = function (dir) {
            if (dir == '') return 'Shared';
            var mf = mFolderByDir[dir.toLowerCase()];
            if (mf && typeof mf.path == 'string' && /^Shared(\/|$)/.test(mf.path)) return mf.path;
            var parts = dir.split('/');
            var parentPath = (parts.length > 1) ? treePathOf(parts.slice(0, -1).join('/')) : null;
            var last = parts[parts.length - 1];
            if (parentPath == null) return (last.toLowerCase() == 'shared') ? 'Shared' : 'Shared/' + last;
            return parentPath + '/' + last;
        };
        var ensureFolder = async function (path, sortOrder) {
            var parts = path.split('/');
            for (var i = 1; i <= parts.length; i++) {
                var pth = parts.slice(0, i).join('/');
                if (folderByPath[pth.toLowerCase()]) continue;
                var doc = { _id: null, type: 'folder', name: parts[i - 1], path: pth };
                if (apply) {
                    var r = await obj.db.addFolder(parts[i - 1], pth);
                    doc._id = r && r.insertedId;
                    if (i == parts.length && typeof sortOrder == 'number' && doc._id != null) await obj.db.update(doc._id, { sortOrder: sortOrder });
                }
                folderByPath[pth.toLowerCase()] = doc;
                result.foldersCreated.push(pth);
            }
            return folderByPath[path.toLowerCase()].path; // existing folder's exact casing
        };

        for (const e of entries) {
            if (e.name == obj.EXPORT_MANIFEST) continue;
            if (e.isDir) {
                var dpath = treePathOf(e.name.replace(/\/$/, ''));
                var mf = mFolderByDir[e.name.replace(/\/$/, '').toLowerCase()];
                await ensureFolder(dpath, mf ? mf.sortOrder : null);
                continue;
            }
            if (e.error) { result.skipped.push(e.name + ' (' + e.error + ')'); continue; }
            var slash = e.name.lastIndexOf('/');
            var dir = slash >= 0 ? e.name.substring(0, slash) : '';
            var base = e.name.substring(slash + 1);
            var dot = base.lastIndexOf('.');
            var ext = dot > 0 ? base.substring(dot).toLowerCase() : '';
            var ftype = obj.TYPE_BY_EXT[ext];
            if (!ftype) { result.skipped.push(e.name + ' (not a .ps1, .bat, .cmd or .sh file)'); continue; }

            var ms = mScriptByFile[e.name.toLowerCase()];
            var name = (ms && ms.name) ? String(ms.name) : base.substring(0, dot);
            var path = await ensureFolder(treePathOf(dir), null);
            var content = e.data.toString('utf8').replace(/^﻿/, '');
            if (ftype == 'bash') content = content.split('\r\n').join('\n').split('\r').join('\n');

            // match: manifest id (same server) -> same folder + name -> new
            var existing = (ms && ms.id && scriptById[String(ms.id)]) || null;
            if (existing == null) {
                existing = all.find(d => d.type == 'script' && d.path.toLowerCase() == path.toLowerCase() && String(d.name) === name) || null; // names are case-sensitive ("dup" and "Dup" can both exist)
            }
            if (existing) {
                var changed = (existing.content || '') !== content || existing.name !== name || existing.path !== path || existing.filetype !== ftype;
                if (!changed) { result.unchanged++; plan.push(['n', String(existing._id), existing.contentHash || '']); continue; }
                var label = path + '/' + name;
                var was = existing.path + '/' + existing.name;
                if (was !== label) label += '  (was ' + was + ')';
                // Changed on the server since this export was made? Importing would overwrite that work.
                if (ms && ms.hash && existing.contentHash && ms.hash !== existing.contentHash && (existing.content || '') !== content) {
                    result.conflicts.push(path + '/' + name + '  (content changed on the server since the export)');
                } else if (ms && ms.id && String(existing._id) === String(ms.id) && ((ms.path != null && ms.path !== existing.path) || (ms.name != null && ms.name !== existing.name))) {
                    result.conflicts.push(path + '/' + name + '  (moved or renamed on the server since the export; was ' + ms.path + '/' + ms.name + ' when exported, now ' + existing.path + '/' + existing.name + ')');
                }
                plan.push(['u', String(existing._id), existing.contentHash || '', existing.path, existing.name]);
                if (apply) {
                    await obj.db.update(existing._id, { type: 'script', filetype: ftype, name: name, path: path, content: content });
                    if (existing.name !== name) await obj.db.updateScriptJobName(String(existing._id), name);
                }
                existing.content = content; existing.name = name; existing.path = path; existing.filetype = ftype;
                result.updated.push(label);
            } else {
                plan.push(['c', path.toLowerCase(), name]);
                var doc = { _id: null, type: 'script', name: name, path: path, filetype: ftype, content: content };
                if (apply) {
                    var ins = await obj.db.addScript(name, content, path, ftype);
                    doc._id = ins && ins.insertedId;
                    if (ms && typeof ms.sortOrder == 'number' && doc._id != null) await obj.db.update(doc._id, { sortOrder: ms.sortOrder });
                }
                all.push(doc);
                if (doc._id != null) scriptById[String(doc._id)] = doc;
                result.created.push(path + '/' + name);
            }
        }
        plan.push(['f'].concat(result.foldersCreated));
        result.token = require('crypto').createHash('sha256').update(JSON.stringify(plan)).digest('hex');
        return result;
    };

    obj.historyData = function (message) {
        if (typeof pluginHandler.scripttask.loadHistory == 'function') pluginHandler.scripttask.loadHistory(message);
        if (typeof pluginHandler.scripttask.loadSchedule == 'function') pluginHandler.scripttask.loadSchedule(message);
    };
    
    obj.variableData = function (message) {
        if (typeof pluginHandler.scripttask.loadVariables == 'function') pluginHandler.scripttask.loadVariables(message);
    };
    
    obj.determineNextJobTime = function(s) {
        var nextTime = null;
        var nowTime = Math.floor(new Date() / 1000);
        
        // special case: we've reached the end of our run
        if (s.endAt !== null && s.endAt <= nowTime) {
            return nextTime;
        }

        switch (s.recur) {
            case 'once':
                if (s.nextRun == null) nextTime = s.startAt;
                else nextTime = null;
            break;
            case 'minutes':
                /*var lRun = s.nextRun || nowTime;
                if (lRun == null) lRun = nowTime;
                nextTime = lRun + (s.interval * 60);
                if (s.startAt > nextTime) nextTime = s.startAt;*/
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60);
                // this prevents "catch-up" tasks being scheduled if an endpoint is offline for a long period of time
                // e.g. always make sure the next scheduled time is relevant to the scheduled interval, but in the future
                if (nextTime < nowTime) {
                    // initially I was worried about this causing event loop lockups
                    // if there was a long enough time gap. Testing over 50 years of backlog for a 3 min interval
                    // still ran under a fraction of a second. Safe to say this approach is safe! (~8.5 million times)
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'hourly':
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60 * 60);
                if (nextTime < nowTime) {
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60 * 60);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'daily':
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60 * 60 * 24);
                if (nextTime < nowTime) {
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60 * 60 * 24);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'weekly':
                var tempDate = new Date();
                var nowDate = new Date(tempDate.getFullYear(), tempDate.getMonth(), tempDate.getDate());
                
                if (s.daysOfWeek.length == 0) {
                    nextTime = null;
                    break;
                }
                s.daysOfWeek = s.daysOfWeek.map(el => Number(el));
                var baseTime = s.startAt;
                //console.log('dow is ', s.daysOfWeek);
                var lastDayOfWeek = Math.max(...s.daysOfWeek);
                var startX = 0;
                //console.log('ldow is ', lastDayOfWeek);
                if (s.nextRun != null) {
                    baseTime = s.nextRun;
                    //console.log('basetime 2: ', baseTime);
                    if (nowDate.getDay() == lastDayOfWeek) {
                        baseTime = baseTime + ( s.interval * 604800 ) - (lastDayOfWeek * 86400);
                        //console.log('basetime 3: ', baseTime);
                    }
                    startX = 0;
                } else if (s.startAt < nowTime) {
                    baseTime = Math.floor(nowDate.getTime() / 1000);
                    //console.log('basetime 4: ', baseTime);
                }
                //console.log('startX is: ', startX);
                //var secondsFromMidnight = nowTimeDate.getSeconds() + (nowTimeDate.getMinutes() * 60) + (nowTimeDate.getHours() * 60 * 60);
                //console.log('seconds from midnight: ', secondsFromMidnight);
                //var dBaseTime = new Date(0); dBaseTime.setUTCSeconds(baseTime);
                //var dMidnight = new Date(dBaseTime.getFullYear(), dBaseTime.getMonth(), dBaseTime.getDate());
                //baseTime = Math.floor(dMidnight.getTime() / 1000);
                for (var x = startX; x <= 7; x++){
                    var checkDate = baseTime + (86400 * x);
                    var d = new Date(0); d.setUTCSeconds(checkDate);
                    var dm = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                    
                    //console.log('if break check :', (s.daysOfWeek.indexOf(d.getDay()) !== -1 && checkDate >= nowTime));
                    //console.log('checkDate vs nowTime: ', (checkDate - nowTime), ' if positive, nowTime is less than checkDate');
                    if (s.nextRun == null && s.daysOfWeek.indexOf(dm.getDay()) !== -1 && dm.getTime() >= nowDate.getTime()) break;
                    if (s.daysOfWeek.indexOf(dm.getDay()) !== -1 && dm.getTime() > nowDate.getTime()) break;
                    //if (s.daysOfWeek.indexOf(d.getDay()) !== -1 && Math.floor(d.getTime() / 1000) >= nowTime) break;
                }
                var sa = new Date(0); sa.setUTCSeconds(s.startAt);
                var sad = new Date(sa.getFullYear(), sa.getMonth(), sa.getDate());
                var diff = (sa.getTime() - sad.getTime()) / 1000;
                nextTime = Math.floor(dm.getTime() / 1000) + diff;
                //console.log('next schedule is ' + d.toLocaleString());
            break;
            default:
                nextTime = null;
            break;
        }
        
        if (s.endAt != null && nextTime > s.endAt) nextTime = null; // if the next time reaches the bound of the endAt time, nullify
        
        return nextTime;
    };

    // Serialized: concurrent runs (queue timer + jobComplete) used to both see "no incomplete
    // job" for a schedule and each create one, doubling up runs.
    obj.scheduleLock = Promise.resolve();
    obj.makeJobsFromSchedules = function(scheduleId) {
        var run = obj.scheduleLock.then(() => obj._makeJobsFromSchedules(scheduleId));
        obj.scheduleLock = run.catch(() => {});
        return run;
    };

    obj._makeJobsFromSchedules = async function(scheduleId) {
        var schedules = await obj.db.getSchedulesDueForJob(scheduleId);
        if (!schedules || schedules.length == 0) return;
        for (const s of schedules) {
            try {
                var nextJobTime = obj.determineNextJobTime(s);
                if (nextJobTime === null) {
                    await obj.db.removeJobSchedule(s._id);
                    continue;
                }
                // If a previous run for this schedule hasn't completed (device probably offline),
                // don't queue another one. Results in at most one queued run per schedule.
                var incomplete = await obj.db.getIncompleteJobsForSchedule(s._id);
                if (incomplete.length > 0) continue;
                var scripts = await obj.db.get(s.scriptId);
                if (scripts.length == 0) { await obj.db.removeJobSchedule(s._id); continue; } // script deleted
                await obj.db.addJob({ scriptId: s.scriptId, scriptName: scripts[0].name, node: s.node, runBy: s.scheduledBy, dontQueueUntil: nextJobTime, jobSchedule: s._id });
                await obj.db.update(s._id, { nextRun: nextJobTime });
                obj.updateFrontEnd({ scriptId: s.scriptId, nodeId: s.node });
            } catch (e) {
                console.log('PLUGIN: ScriptTask: Error managing job schedules: ', e);
            }
        }
    };

    obj.deleteElement = async function (command) {
        try {
            var found = await obj.db.get(command.id);
            var file = found[0];
            if (file == null) return;
            var updateObj = { tree: true };
            if (file.type == 'folder') {
                if (file.path == 'Shared') throw Error('Cannot delete the top level folder: Shared');
                // delete everything inside, including nested folders, and their schedules / pending jobs
                var all = await obj.db.getTreeItems();
                var inside = all.filter(d => d._id != file._id && obj.isWithinPath(d.path, file.path));
                for (const d of inside) {
                    if (d.type == 'script') await obj.db.deleteScriptSchedulesAndPendingJobs(d._id);
                    await obj.db.delete(d._id);
                }
            } else if (file.type == 'script') {
                await obj.db.deleteScriptSchedulesAndPendingJobs(file._id);
            } else if (file.type == 'jobSchedule') {
                await obj.db.deletePendingJobsForSchedule(file._id);
                updateObj.scriptId = file.scriptId;
                updateObj.nodeId = file.node;
            }
            await obj.db.delete(command.id);
            obj.updateFrontEnd(updateObj);
        } catch (e) { console.log('PLUGIN: ScriptTask: Error deleting ', e); }
    };

    // ---- Script tree organisation -------------------------------------------------------------
    // Folders store their full path (e.g. "Shared/Installers"); scripts store the path of the folder
    // they are in. "sortOrder" (optional) orders items within a folder; unordered items go last.

    obj.isWithinPath = function (path, folderPath) {
        return path === folderPath || (typeof path == 'string' && path.indexOf(folderPath + '/') === 0);
    };

    // Re-root every item at or below oldPath to newPath (covers nested folders).
    obj.repath = async function (oldPath, newPath) {
        if (oldPath === newPath) return;
        var all = await obj.db.getTreeItems();
        for (const d of all) {
            if (obj.isWithinPath(d.path, oldPath)) {
                await obj.db.update(d._id, { path: newPath + d.path.substring(oldPath.length) });
            }
        }
    };

    // Move an item (script or folder) into the folder at toPath and/or set the order of that folder's
    // children. "order" is the full list of child ids for the destination folder, in display order.
    obj.reorderItem = async function (id, toPath, order) {
        var found = await obj.db.get(id);
        var item = found[0];
        if (item == null || (item.type != 'script' && item.type != 'folder')) throw Error('Item not found');
        var all = await obj.db.getTreeItems();
        var dest = all.find(d => d.type == 'folder' && d.path === toPath);
        if (dest == null) throw Error('Destination folder not found: ' + toPath);

        if (item.type == 'folder') {
            if (item.path == 'Shared') throw Error('Cannot move the top level folder: Shared');
            var currentParent = item.path.substring(0, item.path.lastIndexOf('/'));
            if (currentParent !== toPath) {
                if (obj.isWithinPath(toPath, item.path)) throw Error('Cannot move a folder into itself');
                var newPath = toPath + '/' + item.name;
                if (all.some(d => d.type == 'folder' && d.path === newPath)) throw Error('A folder named "' + item.name + '" already exists there');
                await obj.repath(item.path, newPath);
            }
        } else if (item.path !== toPath) {
            await obj.db.update(item._id, { path: toPath });
        }

        if (Array.isArray(order)) {
            var ids = order.map(String);
            if (ids.indexOf(String(item._id)) === -1) ids.push(String(item._id));
            var valid = {};
            all.forEach(d => { valid[String(d._id)] = true; });
            for (var k = 0; k < ids.length; k++) {
                if (valid[ids[k]]) await obj.db.update(ids[k], { sortOrder: k });
            }
        }
    };

    obj.serveraction = function(command, myparent, grandparent) {
        if (command == null || typeof command.pluginaction != 'string' || myparent == null) return;
        if (myparent.user == null) {
            // From an agent: only the agent-side protocol is allowed.
            if (!obj.AGENT_ACTIONS[command.pluginaction] || typeof myparent.dbNodeKey != 'string') {
                console.log('PLUGIN: ScriptTask: Rejected "' + command.pluginaction + '" from agent ' + myparent.dbNodeKey);
                return;
            }
        } else {
            if (!obj.isAdmin(myparent.user)) {
                console.log('PLUGIN: ScriptTask: Rejected "' + command.pluginaction + '" from non-administrator ' + myparent.user._id);
                return;
            }
            if (obj.AGENT_ACTIONS[command.pluginaction]) return; // agent-only actions
        }
        switch (command.pluginaction) {
            case 'addScript':
                obj.db.addScript(command.name, command.content, command.path, command.filetype)
                .then(() => {
                    obj.updateFrontEnd( { tree: true } );
                });            
            break;
            case 'new':
                var parent_path = '';
                var new_path = '';
                obj.db.get(command.parent_id)
                .then(found => {
                  if (found.length > 0) {
                      var file = found[0];
                      parent_path = file.path;
                  } else {
                      parent_path = 'Shared';
                  }
                })
                .then(() => {
                    return obj.db.addScript(command.name, '', parent_path, command.filetype);
                })
                .then(() => {
                    obj.updateFrontEnd( { tree: true } );
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Error creating script: ', e); });
            break;
            case 'rename':
              (async () => {
                  var name = String(command.name || '').trim();
                  if (name == '' || name.indexOf('/') !== -1) throw Error('Invalid name');
                  var docs = await obj.db.get(command.id);
                  var doc = docs[0];
                  if (doc == null) return;
                  if (doc.type == 'folder') {
                      if (doc.path == 'Shared') throw Error('Cannot rename the top level folder: Shared');
                      var newPath = doc.path.substring(0, doc.path.lastIndexOf('/')) + '/' + name;
                      var all = await obj.db.getTreeItems();
                      if (all.some(d => d.type == 'folder' && d.path === newPath && String(d._id) != String(doc._id))) throw Error('A folder with that name already exists');
                      await obj.repath(doc.path, newPath);
                  }
                  await obj.db.update(command.id, { name: name });
                  if (doc.type == 'script') await obj.db.updateScriptJobName(command.id, name);
                  obj.updateFrontEnd( { scriptId: command.id, nodeId: command.currentNodeId, tree: true } );
              })()
              .catch(e => { console.log('PLUGIN: ScriptTask: Error renaming: ', e.message || e); obj.updateFrontEnd({ tree: true }); });
            break;
            case 'move': // legacy: drop onto a folder = move to the end of it
              obj.db.get(command.to)
              .then(found => {
                  if (found.length == 0 || found[0].type != 'folder') throw Error('Target destination not found');
                  return obj.reorderItem(command.id, found[0].path, null);
              })
              .then(() => obj.updateFrontEnd( { tree: true } ))
              .catch(e => { console.log('PLUGIN: ScriptTask: Error moving: ', e.message || e); obj.updateFrontEnd({ tree: true }); });
            break;
            case 'reorder':
              obj.reorderItem(command.id, command.toPath, command.order)
              .then(() => obj.updateFrontEnd( { tree: true } ))
              .catch(e => { console.log('PLUGIN: ScriptTask: Error reordering: ', e.message || e); obj.updateFrontEnd({ tree: true }); });
            break;
            case 'newFolder':
              var parent_path = '';
              var new_path = '';
              
              obj.db.get(command.parent_id)
              .then(found => {
                if (found.length > 0) {
                    var file = found[0];
                    parent_path = file.path;
                } else {
                    parent_path = 'Shared';
                }
              })
              .then(() => {
                new_path = parent_path + '/' + command.name;
              })
              .then(() => {
                  return obj.db.addFolder(command.name, new_path);
              })
              .then(() => {
                return obj.updateFrontEnd( { tree: true } );
              })
              .catch(e => { console.log('PLUGIN: ScriptTask: Error creating new folder ', e.stack); });
            break;
            case 'delete':
              obj.deleteElement(command);
            break;
            case 'addScheduledJob':
                /* { 
                    scriptId: scriptId, 
                    node: s, 
                    scheduledBy: myparent.user.name,
                    recur: command.recur, // [once, minutes, hourly, daily, weekly, monthly]
                    interval: x,
                    daysOfWeek: x, // only used for weekly recur val
                    // onTheXDay: x, // only used for monthly
                    startAt: x,
                    endAt: x,
                    runCountLimit: x,
                    lastRun: x,
                    nextRun: x,
                    type: "scheduledJob"
                } */
                var sj = command.schedule;
                if (sj == null || typeof sj != 'object') { console.log('PLUGIN: ScriptTask: addScheduledJob without a schedule'); break; }
                
                var sched = {
                    scriptId: String(command.scriptId), 
                    node: null, 
                    scheduledBy: myparent.user.name,
                    recur: sj.recur,
                    interval: sj.interval,
                    daysOfWeek: sj.dayVals,
                    startAt: sj.startAt,
                    endAt: sj.endAt,
                    lastRun: null,
                    nextRun: null,
                    type: "jobSchedule"
                };
                obj.allowedNodes(myparent, command.nodes)
                .then(nodes => {
                    return obj.db.get(command.scriptId).then(found => {
                        if (found.length == 0 || found[0].type != 'script') throw new Error('Script not found');
                        return Promise.all(nodes.map(n => obj.db.addJobSchedule({ ...sched, ...{ node: n } })));
                    });
                })
                .then(() => obj.makeJobsFromSchedules())
                .then(() => obj.updateFrontEnd({ scriptId: command.scriptId, nodeId: command.currentNodeId }))
                .catch(e => { console.log('PLUGIN: ScriptTask: Error adding schedules. The error was: ', e.message || e); });
            break;
            case 'runScript':
              var scriptId = command.scriptId;
              obj.db.get(scriptId)
              .then(found => {
                  if (found.length == 0 || found[0].type != 'script') throw new Error('Script not found');
                  return obj.allowedNodes(myparent, command.nodes)
                  .then(nodes => Promise.all(nodes.map(n => obj.db.addJob({ scriptId: String(scriptId), scriptName: found[0].name, node: n, runBy: myparent.user.name }))));
              })
              .then(() => {
                  obj.queueRun();
                  obj.updateFrontEnd( { scriptId: scriptId, nodeId: command.currentNodeId } );
              })
              .catch(e => { console.log('PLUGIN: ScriptTask: Error queueing script run: ', e.message || e); });
            break;
            case 'getScript':
                //obj.debug('ScriptTask', 'getScript Triggered', JSON.stringify(command));
                obj.db.hasPendingJobForScript(myparent.dbNodeKey, command.scriptId)
                .then(pending => {
                    if (!pending) { console.log('PLUGIN: ScriptTask: Agent ' + myparent.dbNodeKey + ' asked for a script it has no job for; ignored.'); return []; }
                    return obj.db.get(command.scriptId);
                })
                .then(script => {
                    if (script.length == 0) return;
                    myparent.send(JSON.stringify({ 
                        action: 'plugin',
                        plugin: 'scripttask',
                        pluginaction: 'cacheScript',
                        nodeid: myparent.dbNodeKey,
                        rights: true,
                        sessionid: true,
                        script: script[0]
                    }));
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Error sending script: ', e); });
            break;
            case 'jobComplete':
                var jobId = command.jobId, retVal = command.retVal, errVal = command.errVal, dispatchTime = command.dispatchTime;
                var completeTime = Math.floor(new Date() / 1000);
                delete obj.dispatched[String(jobId)];
                obj.db.get(jobId)
                .then(jobs => {
                    var job = jobs[0];
                    if (job == null || job.type != 'job') return; // job deleted (e.g. "clear pending")
                    if (job.node != myparent.dbNodeKey) { console.log('PLUGIN: ScriptTask: Ignoring jobComplete for a job that belongs to another device.'); return; }
                    if (job.completeTime != null) return; // duplicate report (agent re-sent a stored result)
                    return obj.db.update(jobId, {
                        completeTime: completeTime,
                        returnVal: retVal,
                        errorVal: errVal,
                        dispatchTime: job.dispatchTime || dispatchTime || completeTime
                    })
                    .then(() => {
                        if (job.jobSchedule == null) return;
                        return obj.db.update(job.jobSchedule, { lastRun: completeTime })
                        .then(() => obj.makeJobsFromSchedules(job.jobSchedule));
                    })
                    .then(() => {
                        obj.updateFrontEnd( { scriptId: job.scriptId, nodeId: job.node } );
                    });
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Failed to complete job. ', e); });
            break;
            case 'loadNodeHistory':
                obj.updateFrontEnd( { nodeId: command.nodeId } );
            break;
            case 'loadScriptHistory':
                obj.updateFrontEnd( { scriptId: command.scriptId } );
            break;
            case 'editScript':
                obj.db.get(command.scriptId)
                .then(found => {
                    if (found.length == 0) return;
                    return obj.db.update(command.scriptId, { type: 'script', filetype: found[0].filetype, name: command.scriptName, content: command.scriptContent });
                })
                .then(() => {
                    obj.updateFrontEnd( { scriptId: command.scriptId, tree: true } );
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Error saving script: ', e); });
            break;
            case 'clearAllPendingJobs':
                obj.db.deletePendingJobsForNode(myparent.dbNodeKey)
                .then(() => { obj.updateFrontEnd( { nodeId: myparent.dbNodeKey } ); })
                .catch(e => { console.log('PLUGIN: ScriptTask: Error clearing pending jobs: ', e); });
            break;
            case 'loadVariables':
                obj.updateFrontEnd( { variables: true } );
            break;
            case 'newVar':
                obj.db.addVariable(command.name, command.scope, command.scopeTarget, command.value)
                .then(() => {
                    obj.updateFrontEnd( { variables: true } );
                })
            break;
            case 'editVar':
                obj.db.update(command.id, { 
                    name: command.name, 
                    scope: command.scope, 
                    scopeTarget: command.scopeTarget,
                    value: command.value
                })
                .then(() => {
                    obj.updateFrontEnd( { variables: true } );
                })
            break;
            case 'importScripts':
                var target = [myparent.user._id];
                var apply = (command.apply === true);
                var reply = function (extra) { obj.meshServer.DispatchEvent(target, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'importResult', fileName: command.fileName, apply: apply, ...extra }); };
                if (obj.importBusy) { reply({ error: 'Another import is in progress. Try again in a moment.' }); break; }
                obj.importBusy = true;
                Promise.resolve()
                .then(() => {
                    if (typeof command.data != 'string' || command.data.length > 14 * 1024 * 1024) throw new Error('Import file missing or too large (max 10 MB).');
                    var buf = Buffer.from(command.data, 'base64');
                    if (!apply) return obj.importZip(buf, false);
                    // Final check: the scripts must still be exactly as they were when the preview was confirmed.
                    return obj.importZip(buf, false).then(check => {
                        if (typeof command.token != 'string' || check.token !== command.token) throw new Error('Scripts changed since the preview (or the preview was skipped). Nothing was imported - please import the file again to see a new preview.');
                        return obj.importZip(buf, true);
                    });
                })
                .then(result => {
                    if (apply) console.log('PLUGIN: ScriptTask: ' + myparent.user._id + ' imported ' + command.fileName + ': ' + result.updated.length + ' updated, ' + result.created.length + ' added.');
                    reply({ result: result });
                    if (apply) obj.updateFrontEnd({ tree: true });
                })
                .catch(e => {
                    console.log('PLUGIN: ScriptTask: Import failed: ', e.message || e);
                    reply({ error: String(e.message || e) });
                })
                .finally(() => { obj.importBusy = false; });
            break;
            case 'deleteVar':
                obj.db.delete(command.id)
                .then(() => {
                    obj.updateFrontEnd( { variables: true } );
                })
            break;
            default:
                console.log('PLUGIN: ScriptTask: unknown action');
            break;
        }
    };
    
    return obj;
}
