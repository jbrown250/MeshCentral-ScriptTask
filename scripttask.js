/** 
* @description MeshCentral ScriptTask
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";

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

    obj.server_startup = function() {
        obj.meshServer.pluginHandler.scripttask_db = require (__dirname + '/db.js').CreateDB(obj.meshServer);
        obj.db = obj.meshServer.pluginHandler.scripttask_db;
        obj.resetQueueTimer();
    };
    
    obj.onDeviceRefreshEnd = function() {
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
                var targets = ['*', 'server-users'];
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
                var targets = ['*', 'server-users'];
                obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'historyData', scriptId: null, nodeId: ids.nodeId, scriptHistory: null, nodeHistory: nodeHistory, nodeSchedule: nodeSchedule });
            });
        }
        if (ids.tree === true) {
            obj.db.getScriptTree()
            .then((tree) => {
                var targets = ['*', 'server-users'];
                obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'newScriptTree', tree: tree });
            });
        }
        if (ids.variables === true) {
            obj.db.getVariables()
            .then((vars) => {
                var targets = ['*', 'server-users'];
                obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'variableData', vars: vars });
            });
        }
    };
    
    obj.handleAdminReq = function(req, res, user) {
        if ((user.siteadmin & 0xFFFFFFFF) == 1 && req.query.admin == 1) 
        {
            // admin wants admin, grant
            var vars = {};
            res.render(obj.VIEWS + 'admin', vars);
            return;
        } else if (req.query.admin == 1 && (user.siteadmin & 0xFFFFFFFF) == 0) {
            // regular user wants admin
            res.sendStatus(401); 
            return;
        } else if (req.query.user == 1) { 
            // regular user wants regular access, grant
            if (req.query.dl != null) return obj.downloadFile(req, res, user);
            var vars = {};
            
            if (req.query.edit == 1) { // edit script
                if (req.query.id == null) return res.sendStatus(401); 
                obj.db.get(req.query.id)
                .then((scripts) => {
                    if (scripts[0].filetype == 'proc') {
                        vars.procData = JSON.stringify(scripts[0]);
                        res.render(obj.VIEWS + 'procedit', vars);
                    } else {
                        vars.scriptData = JSON.stringify(scripts[0]);
                        res.render(obj.VIEWS + 'scriptedit', vars);
                    }
                });
                return;
            } else if (req.query.schedule == 1) {
                var vars = {};
                res.render(obj.VIEWS + 'schedule', vars);
                return;
            }
            // default user view (tree)
            vars.scriptTree = 'null';
            obj.db.getScriptTree()
            .then(tree => {
              vars.scriptTree = JSON.stringify(tree);
              res.render(obj.VIEWS + 'user', vars);
            });
            return;
        } else if (req.query.include == 1) {
            switch (req.query.path.split('/').pop().split('.').pop()) {
                case 'css':     res.contentType('text/css'); break;
                case 'js':      res.contentType('text/javascript'); break;
            }
            res.sendFile(__dirname + '/includes/' + req.query.path); // don't freak out. Express covers any path issues.
            return;
        }
        res.sendStatus(401); 
        return;
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

    obj.deleteElement = function (command) {
        var delObj = null;
        obj.db.get(command.id)
        .then((found) => {
          var file = found[0];
          delObj = {...{}, ...found[0]};
          return file;
        })
        .then((file) => {
          if (file.type == 'folder') return obj.db.deleteByPath(file.path); //@TODO delete schedules for scripts within folders
          if (file.type == 'script') return obj.db.deleteSchedulesForScript(file._id);
          if (file.type == 'jobSchedule') return obj.db.deletePendingJobsForSchedule(file._id);
        })
        .then(() => {
          return obj.db.delete(command.id)
        })
        .then(() => {
          var updateObj = { tree: true };
          if (delObj.type == 'jobSchedule') {
              updateObj.scriptId = delObj.scriptId;
              updateObj.nodeId = delObj.node;
          }
          return obj.updateFrontEnd( updateObj );
        })
        .catch(e => { console.log('PLUGIN: ScriptTask: Error deleting ', e.stack); });
    };
    
    obj.serveraction = function(command, myparent, grandparent) {
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
              obj.db.get(command.id)
              .then((docs) => {
                  var doc = docs[0];
                  if (doc.type == 'folder') {
                      return obj.db.update(command.id, { path: doc.path.replace(doc.name, command.name) })
                      .then(() => { // update sub-items
                          return obj.db.getByPath(doc.path)
                      })
                      .then((found) => {
                          if (found.length > 0) {
                            var proms = [];
                            found.forEach(f => {
                              proms.push(obj.db.update(f._id, { path: doc.path.replace(doc.name, command.name) } ));
                            })
                            return Promise.all(proms);
                          }
                      })
                  } else {
                      return Promise.resolve();
                  }
              })
              .then(() => {
                  return obj.db.update(command.id, { name: command.name });
              })
              .then(() => {
                  return obj.db.updateScriptJobName(command.id, command.name);
              })
              .then(() => {
                  obj.updateFrontEnd( { scriptId: command.id, nodeId: command.currentNodeId, tree: true } );
              })
              .catch(e => { console.log('PLUGIN: ScriptTask: Error renaming: ', e); });
            break;
            case 'move':
              var toPath = null, fromPath = null, parentType = null;
              obj.db.get(command.to)
              .then(found => { // get target data
                  if (found.length > 0) {
                    var file = found[0];
                    toPath = file.path;
                  } else throw Error('Target destination not found');
              })
              .then(() => { // get item to be moved
                return obj.db.get(command.id);
              })
              .then((found) => { // set item to new location
                  var file = found[0];
                  if (file.type == 'folder') {
                    fromPath = file.path;
                    toPath += '/' + file.name;
                    parentType = 'folder';
                    if (file.name == 'Shared' && file.path == 'Shared') throw Error('Cannot move top level directory: Shared');
                  }
                  return obj.db.update(command.id, { path: toPath } );
              })
              .then(() => { // update sub-items
                  return obj.db.getByPath(fromPath)
              })
              .then((found) => {
                  if (found.length > 0) {
                    var proms = [];
                    found.forEach(f => {
                      proms.push(obj.db.update(f._id, { path: toPath } ));
                    })
                    return Promise.all(proms);
                  }
              })
              .then(() => {
                return obj.updateFrontEnd( { tree: true } );
              })
              .catch(e => { console.log('PLUGIN: ScriptTask: Error moving ', e.stack); });
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
                
                var sched = {
                    scriptId: command.scriptId, 
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
                var sel = command.nodes;
                var proms = [];
                if (Array.isArray(sel)) {
                  sel.forEach((s) => {
                    var sObj = {...sched, ...{
                        node: s
                    }};
                    proms.push(obj.db.addJobSchedule( sObj ));
                  });
                } else if (sel != null) {
                  proms.push(obj.db.addJobSchedule( {...sched, ...{ node: sel }} ));
                }
                Promise.all(proms)
                .then(() => {
                    obj.makeJobsFromSchedules();
                    return Promise.resolve();
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Error adding schedules. The error was: ', e); });
            break;
            case 'runScript':
              var scriptId = command.scriptId;
              var sel = command.nodes;
              var proms = [];
              if (Array.isArray(sel)) {
                sel.forEach((s) => {
                  proms.push(obj.db.addJob( { scriptId: scriptId, node: s, runBy: myparent.user.name } ));
                });
              } else {
                proms.push(obj.db.addJob( { scriptId: scriptId, node: sel, runBy: myparent.user.name } ));
              }
              Promise.all(proms)
              .then(() => {
                  return obj.db.get(scriptId);
              })
              .then(scripts => {
                  return obj.db.updateScriptJobName(scriptId, scripts[0].name);
              })
              .then(() => {
                  obj.queueRun();
                  obj.updateFrontEnd( { scriptId: scriptId, nodeId: command.currentNodeId } );
              })
              .catch(e => { console.log('PLUGIN: ScriptTask: Error queueing script run: ', e); });
            break;
            case 'getScript':
                //obj.debug('ScriptTask', 'getScript Triggered', JSON.stringify(command));
                obj.db.get(command.scriptId)
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
