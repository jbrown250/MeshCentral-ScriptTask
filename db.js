/** 
* @description MeshCentral-ScriptTask database module
* @author Ryan Blenis
* @copyright Ryan Blenis 2019
* @license Apache-2.0
*/

"use strict";
var Datastore = null;
var formatId = null;

module.exports.CreateDB = function(meshserver) {
    var obj = {};
    var NEMongo = require(__dirname + '/nemongo.js');
    module.paths.push(require('path').join(meshserver.parentpath, 'node_modules')); // we need to push the node_modules folder for nedb
    obj.dbVersion = 1;
    
    obj.initFunctions = function () {
        obj.updateDBVersion = function(new_version) {
          return obj.scriptFile.updateOne({type: "db_version"}, { $set: {version: new_version} }, {upsert: true});
        };
        
        obj.getDBVersion = function() {
            return obj.scriptFile.find( { type: "db_version" } ).project( { _id: 0, version: 1 } ).toArray()
            .then(vers => (vers.length == 0) ? 1 : vers[0]['version']);
        };

        obj.addScript = function(name, content, path, filetype) {
            if (path == null) path = "Shared"
            if (filetype == 'bash') content = content.split('\r\n').join('\n').split('\r').join('\n');
            var sObj = { 
                type: 'script',
                path: path,
                name: name,
                content: content,
                contentHash: require('crypto').createHash('sha384').update(content).digest('hex'),
                filetype: filetype
            };
            return obj.scriptFile.insertOne(sObj);
        };
        
        obj.addFolder = function(name, path) {
            var sObj = {
                type: 'folder',
                path: path,
                name: name
            };
            return obj.scriptFile.insertOne(sObj);
        };
        
        obj.getScriptTree = function() {
            return obj.scriptFile.find(
                { type:
                    { $in: [ 'script', 'folder' ] }
                }
            ).sort(
                { path: 1, type: 1, name: 1 }
            ).project(
                { name: 1, path: 1, type: 1, filetype: 1, sortOrder: 1 }
            ).toArray();
        };
        obj.getTreeItems = function() {
            return obj.scriptFile.find( { type: { $in: [ 'script', 'folder' ] } } ).project( { name: 1, path: 1, type: 1, sortOrder: 1 } ).toArray();
        };
        obj.deleteScriptSchedulesAndPendingJobs = function(scriptId) {
            var sid = String(scriptId);
            return obj.scriptFile.deleteMany( { type: 'jobSchedule', scriptId: sid } )
            .then(() => obj.scriptFile.deleteMany( { type: 'job', scriptId: sid, completeTime: null } ));
        };
        
        obj.update = function(id, args) {
            id = formatId(id);
            if (args.type == 'script' && typeof args.content == 'string') {
                if (args.filetype == 'bash') {
                    args.content = args.content.split('\r\n').join('\n').split('\r').join('\n');
                }
                args.contentHash = require('crypto').createHash('sha384').update(args.content).digest('hex');
            }
            return obj.scriptFile.updateOne( { _id: id }, { $set: args } );
        };
        obj.delete = function(id) {
            id = formatId(id);
            return obj.scriptFile.deleteOne( { _id: id } );
        };
        obj.deleteByPath = function(path) {
          return obj.scriptFile.deleteMany( { path: path, type: { $in: ['script', 'folder'] } } );
        };
        obj.deleteSchedulesForScript = function(id) {
            // schedules store scriptId as the string id sent by the browser
            return obj.scriptFile.deleteMany( { type: 'jobSchedule', scriptId: String(id) } );
        };
        obj.getByPath = function(path) {
          return obj.scriptFile.find( { type: { $in: [ 'script', 'folder' ] }, path: path }).toArray();
        };
        obj.get = function(id) {
            if (id == null || id == 'null') return Promise.resolve([]);
            try { id = formatId(id); } catch (e) { return Promise.resolve([]); } // malformed id
            return obj.scriptFile.find( { _id: id } ).toArray();
        };
        obj.addJob = function(passedObj) {
          var nowTime = Math.floor(new Date() / 1000);
          var defaultObj = { 
              type: 'job',
              queueTime: nowTime,
              dontQueueUntil: nowTime,
              dispatchTime: null,
              completeTime: null,
              node: null,
              scriptId: null,
              scriptName: null, // in case the original reference is deleted in the future
              replaceVars: null,
              returnVal: null,
              errorVal: null,
              returnAct: null,
              runBy: null,
              jobSchedule: null
          };
          var jObj = {...defaultObj, ...passedObj};
          
          if (jObj.node == null || jObj.scriptId == null) { console.log('PLUGIN: ScriptTask: Could not add job'); return Promise.resolve(null); }
          
          return obj.scriptFile.insertOne(jObj);
        };
        obj.addJobSchedule = function(schedObj) {
            schedObj.type = 'jobSchedule';
            if (schedObj.node == null || schedObj.scriptId == null) { console.log('PLUGIN: ScriptTask: Could not add job schedule'); return Promise.resolve(null); }
            return obj.scriptFile.insertOne(schedObj);
        };
        obj.removeJobSchedule = function (id) {
            return obj.delete(id);
        };
        obj.getSchedulesDueForJob = function(scheduleId) {
            var nowTime = Math.floor(new Date() / 1000);
            var scheduleIdLimiter = {};
            if (scheduleId != null) {
                try { scheduleIdLimiter._id = formatId(scheduleId); } catch (e) { return Promise.resolve([]); }
            }
            // Note: schedules past their endAt are intentionally included so that
            // determineNextJobTime() returns null and the schedule gets removed.
            return obj.scriptFile.find( { 
                type: 'jobSchedule',
                $or: [
                    { nextRun: null }, 
                    { nextRun: { $lte: (nowTime + 60) } } // check a minute into the future
                ],
                ...scheduleIdLimiter
            }).toArray();
        };
        obj.deletePendingJobsForNode = function(node) {
            return obj.scriptFile.deleteMany({ 
                type: 'job', 
                node: node,
                completeTime: null,
            });
        };
        obj.getPendingJobs = function(nodeScope) {
          if (nodeScope == null || !Array.isArray(nodeScope)) {
            return Promise.resolve([]);
          }
          // return jobs that has online nodes and queue time requirements have been met
          return obj.scriptFile.find( { 
              type: 'job', 
              node: { $in: nodeScope },
              completeTime: null,
              //dispatchTime: null,
              $or: [
                  { dontQueueUntil: null }, 
                  { dontQueueUntil: { $lte: Math.floor(new Date() / 1000) } }
              ]
          }).sort({ queueTime: 1 }).limit(5000).toArray();
        };
        // runById (optional): only jobs launched by that user (what a non-administrator sees)
        obj.getJobNodeHistory = function(nodeId, runById) {
            var q = { type: 'job', node: nodeId };
            if (runById != null) q.runById = runById;
            return obj.scriptFile.find(q).sort({ queueTime: -1 }).limit(200).toArray();
        };
        obj.getJobScriptHistory = function(scriptId, runById) {
            var q = { type: 'job', scriptId: String(scriptId) };
            if (runById != null) q.runById = runById;
            return obj.scriptFile.find(q).sort({ completeTime: -1, queueTime: -1 }).limit(200).toArray();
        };
        obj.updateScriptJobName = function(scriptId, scriptName) {
            return obj.scriptFile.updateMany({ type: 'job', scriptId: scriptId }, { $set: { scriptName: scriptName } });    
        };
        obj.getJobSchedulesForScript = function(scriptId) {
            return obj.scriptFile.find( { type: 'jobSchedule', scriptId: scriptId } ).toArray();
        };
        obj.getJobSchedulesForNode = function (nodeId) {
            return obj.scriptFile.find( { type: 'jobSchedule', node: nodeId } ).toArray();
        };
        obj.hasPendingJobForScript = function (node, scriptId) {
            if (typeof node != 'string' || scriptId == null) return Promise.resolve(false);
            return obj.scriptFile.find( { type: 'job', node: node, scriptId: String(scriptId), completeTime: null } ).limit(1).toArray()
            .then(jobs => jobs.length > 0);
        };
        obj.getIncompleteJobsForSchedule = function (schedId) {
            return obj.scriptFile.find( { type: 'job', jobSchedule: schedId, completeTime: null } ).toArray();
        };
        obj.deletePendingJobsForSchedule = function (schedId) {
            return obj.scriptFile.deleteMany( { type: 'job', jobSchedule: schedId, completeTime: null } );
        };
        obj.deleteOldHistory = function() {
            var nowTime = Math.floor(new Date() / 1000);
            var oldTime = nowTime - (86400 * 90); // 90 days
            return obj.scriptFile.deleteMany( { type: 'job', completeTime: { $lte: oldTime } } )
            .then(() => {
                // jobs that were queued 90+ days ago and never ran (device gone, etc.)
                return obj.scriptFile.deleteMany( { type: 'job', completeTime: null, queueTime: { $lte: oldTime } } );
            });
        };
        obj.addVariable = function(name, scope, scopeTarget, value) {
            var vObj = { 
                type: 'variable',
                name: name,
                scope: scope,
                scopeTarget: scopeTarget,
                value: value
            };
            return obj.scriptFile.insertOne(vObj);
        };
        obj.getVariables = function(limiters) {
            if (limiters != null) {
                var find = { 
                    type: 'variable',
                    name: { $in: limiters.names },
                    $or: [ 
                        { scope: 'global' },
                        { $and: [
                            { scope: 'script' },
                            { scopeTarget: limiters.scriptId }
                          ]
                        },
                        { $and: [
                            { scope: 'mesh' },
                            { scopeTarget: limiters.meshId }
                          ]
                        },
                        { $and: [
                            { scope: 'node' },
                            { scopeTarget: limiters.nodeId }
                          ]
                        }
                    ]
                };
                return obj.scriptFile.find(find).sort({ name: 1 }).toArray();
            }
            else {
                return obj.scriptFile.find({ type: 'variable' }).sort({ name: 1 }).toArray();
            }
        };
        obj.checkDefaults = function() {
            obj.scriptFile.find( { type: 'folder', name: 'Shared', path: 'Shared' } ).toArray()
            .then(found => {
              if (found.length == 0) obj.addFolder('Shared', 'Shared');
            })
            .catch(e => { console.log('PLUGIN: ScriptTask: Default folder check failed. Error was: ', e); });
        };
        
        obj.checkDefaults();
    };
    
    // An in-place plugin upgrade creates a new instance of this module. Reuse the existing database
    // handle instead of opening a second one: two NeDB instances on one file overwrite each other's
    // data when they compact. The query functions are still rebuilt from the new code.
    var ph = meshserver.pluginHandler || {};
    var shared = ph._scripttaskStore;
    if (shared != null && shared.collection != null) {
        obj.scriptFile = (shared.kind == 'nedb') ? new NEMongo(shared.collection) : shared.collection;
        formatId = shared.formatId;
        obj.initFunctions();
        return obj;
    }

    if (meshserver.args.mongodb) { // use MongDB
      // Promise API: works with mongodb driver 3.x through 6.x (callbacks were removed in 5.x)
      require('mongodb').MongoClient.connect(meshserver.args.mongodb)
      .then(async function (client) {
          var dbname = 'meshcentral';
          if (meshserver.args.mongodbname) { dbname = meshserver.args.mongodbname; }
          const db = client.db(dbname);
          obj.scriptFile = db.collection('plugin_scripttask');

          var mongodb = require('mongodb');
          formatId = function (id) {
              if (id != null && typeof id == 'object') return id;
              return (typeof mongodb.ObjectId == 'function') ? new mongodb.ObjectId(id) : mongodb.ObjectID(id);
          };
          obj.initFunctions();
          ph._scripttaskStore = { kind: 'mongo', collection: obj.scriptFile, formatId: formatId };

          try {
              var indexes = await obj.scriptFile.indexes();
              var indexesByName = {}, indexCount = 0;
              for (var i in indexes) { indexesByName[indexes[i].name] = indexes[i]; indexCount++; }
              var wanted = ['ScriptName1', 'ScriptPath1', 'JobTime1', 'JobNode1', 'JobScriptID1', 'TypeComplete1', 'JobSchedule1'];
              if ((indexCount != wanted.length + 1) || wanted.some(n => indexesByName[n] == null)) {
                  console.log('Resetting plugin (ScriptTask) indexes...');
                  await obj.scriptFile.dropIndexes();
                  await obj.scriptFile.createIndex({ name: 1 }, { name: 'ScriptName1' });
                  await obj.scriptFile.createIndex({ path: 1 }, { name: 'ScriptPath1' });
                  await obj.scriptFile.createIndex({ queueTime: 1 }, { name: 'JobTime1' });
                  await obj.scriptFile.createIndex({ node: 1 }, { name: 'JobNode1' });
                  await obj.scriptFile.createIndex({ scriptId: 1 }, { name: 'JobScriptID1' });
                  await obj.scriptFile.createIndex({ type: 1, completeTime: 1 }, { name: 'TypeComplete1' });
                  await obj.scriptFile.createIndex({ jobSchedule: 1 }, { name: 'JobSchedule1' });
              }
          } catch (e) { console.log('PLUGIN: ScriptTask: Index check failed: ', e); }
      })
      .catch(function (err) { console.log('PLUGIN: ScriptTask: Unable to connect to database: ' + err); });
    } else { // use NeDb
        try { Datastore = require('@seald-io/nedb'); } catch (ex) { } // This is the NeDB with Node 23 support.
        if (Datastore == null) {
            try { Datastore = require('@yetzt/nedb'); } catch (ex) { } // This is the NeDB with fixed security dependencies.
            if (Datastore == null) { Datastore = require('nedb'); } // So not to break any existing installations, if the old NeDB is present, use it.
        }
        if (obj.scriptFilex == null) {
            obj.scriptFilex = new Datastore({ filename: meshserver.getConfigFilePath('plugin-scripttask.db'), autoload: true });
            obj.scriptFilex.setAutocompactionInterval(40000);
            obj.scriptFilex.ensureIndex({ fieldName: 'name' });
            obj.scriptFilex.ensureIndex({ fieldName: 'path' });
            obj.scriptFilex.ensureIndex({ fieldName: 'queueTime' });
            obj.scriptFilex.ensureIndex({ fieldName: 'node' });
            obj.scriptFilex.ensureIndex({ fieldName: 'scriptId' });
            obj.scriptFilex.ensureIndex({ fieldName: 'type' });
            obj.scriptFilex.ensureIndex({ fieldName: 'jobSchedule' });
        }
        obj.scriptFile = new NEMongo(obj.scriptFilex);
        formatId = function(id) { return id; };
        ph._scripttaskStore = { kind: 'nedb', collection: obj.scriptFilex, formatId: formatId };
        obj.initFunctions();
    }
    
    return obj;
}
