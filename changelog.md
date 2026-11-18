# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Known Issues]
- None. Please feel free to submit an issue via [GitHub](https://github.com/jbrown250/MeshCentral-ScriptTask) if you find anything.

## [0.1.2] - 2026-11-18
### Added
- Organise the script list: drag a script or folder onto another item to place it before or after it, or onto a folder to move it in. Toolbar **Move** (pick a folder) and **▲ / ▼** (reorder) do the same without dragging. The order is saved per folder; new scripts go at the end.
- Folders show nested, and can be collapsed with the arrow or a double-click. Collapsed folders are remembered.
### Fixed
- Moving or renaming a folder now updates nested sub-folders and their scripts (previously only direct children).
- Deleting a folder removes everything inside it, including nested folders, and their schedules and pending jobs.
- Deleting a script removes its schedules on MongoDB too (string vs ObjectId mismatch).
- Folder names are no longer matched by prefix (e.g. "Apps" vs "Apps2") when collapsing.
- "Run" with a folder selected now shows the "select a script" message.

## [0.1.1] - 2026-11-18
### Fixed
- Removed the agent's check for jobs whose process seemed to have disappeared. It could mark long-running scripts (e.g. backups) as failed with "Script process disappeared before completing" while they were still running. Jobs now stay "Running" until the script actually exits.
- The agent now holds a reference to each running script's process object until it exits. Without it, the agent's garbage collector could clean the object up mid-run. That can drop the exit event (the job hangs as "Running") and may kill the script. This is a likely cause of long scripts dying partway through, and of the repeat runs in older versions. There is no run-time limit. An agent restart mid-run is still reported as "interrupted".

## [0.1.0] - 2026-11-10
### Fixed
- Scripts being launched over and over. The server re-sent every unfinished job to the agent every minute, and the agent's duplicate check was unreliable (a broken array helper removed the wrong entries from the running-jobs list). Jobs are now only re-sent when the agent reconnects, or after 15 minutes to recover a lost result, and the agent keeps a persistent record of each job it has run.
- A job that already finished is never run again: the agent re-sends its saved result instead.
- If the agent restarts or the device reboots while a job is running (for example, a script that restarts the agent), the job is reported as "interrupted" and is not re-run in a loop.
- Overlapping queue runs (the timer, "Run" button and job completion firing together) could dispatch the same job or create the same scheduled job twice. Queue runs and schedule processing are now serialized.
- Temp script and output files filling the MeshAgent folder. They now go in a `scripttask` subfolder, each file is deleted on its own (previously, a failed delete of the output file left the script file behind), and leftover `st*.ps1/.bat/.sh/.txt` files from older versions are cleaned up automatically.
- The agent module no longer modifies `Array.prototype` for the whole meshcore.
- Variable substitution no longer changes the cached script when several jobs share a download. Variable names containing regex characters now work.
- Jobs for deleted scripts are closed with an error instead of being retried every minute. Schedules for deleted scripts are removed.
- NeDB query state (sort, limit, projection) leaked between queries.
- `jobComplete` is ignored for jobs that belong to a different device, and duplicate reports are ignored.
- MongoDB: uses the promise API (driver 5/6 removed callbacks), creates ObjectIds correctly, and no longer exits the MeshCentral process when the connection fails.
- Bash scripts edited in the UI now have CRLF line endings normalised.
- Weekly schedules no longer write to the server console every minute.
- Smaller fixes: `clearInterval` on timer reset, a ReferenceError in single-node scheduling, and missing promise returns in new/rename.
### Changed
- The ScriptTask tab now fills the browser window and resizes with it, instead of a fixed 700px frame. The script list and the info panels scroll on their own, and the horizontal scrollbar is gone.
### Added
- Agent console commands: `plugin scripttask status`, `plugin scripttask cleanup` and `plugin scripttask clearState`.
- Database indexes on `type`/`completeTime` and `jobSchedule`.

## [0.0.20] - 2025-01-08
### Fixed
- Merge PR fixing MeshCentral 1.1.35+ compatibility

## [0.0.19] - 2024-02-07
### Fixed
- Merge PR fixing scroll bars and Powershell execution policy

## [0.0.18] - 2022-03-12
### Fixed
- Compatibility with MeshCentral => 0.9.98 (promise requirement removed from MeshCentral, nedb moved to @yetzt/nedb)

## [0.0.17] - 2021-10-07
### Fixed
- Compatibility with MeshCentral > 0.9.7

## [0.0.16] - 2021-05-18
### Fixed
- Drag/drop scripts between folders

## [0.0.15] - 2020-03-07
### Fixed
- Prevent race condition with conflicting plugins changing the app views directory by using absolute paths

## [0.0.14] - 2020-02-28
### Added
- Add new script from ScriptTask plugin without dragging/uploading an existing script
- Variables introduced. Supports global, script, mesh, and node level. Overridden in that order.

## [0.0.13] - 2020-02-15
### Fixed
- Folder rename function now working as intended
- Removed ability to "edit" folders as if they were a script

## [0.0.12] - 2020-02-14
### Fixed
- Rename function broke when filetype tags were added

## [0.0.11] - 2020-01-24
### Added
- Advanced selection of nodes based on mesh and tag membership

## [0.0.10] - 2020-01-02
### Fixed
- Removed logging to MeshCentral events DB for each script run / refresh event (causing events file to grow quickly and crash NeDB instances)

## [0.0.9] - 2019-12-24
### Fixed
- Native Powershell scripts now run correctly on more versions of Linux/MacOS

## [0.0.8] - 2019-12-23
### Fixed
- Force strip carriage returns from bash scripts

## [0.0.7] - 2019-12-23
### Fixed
- Some versions of Linux don't default the agents root to the MeshAgent's directory. Added path detection for a safe temp zone. Thanks /u/Reverent for the assist in debugging that one!

## [0.0.6] - 2019-12-23
### Added
- Status return of a script as success/failure if the script does not produce output
- Endpoint debugging toggle via console (plugin scripttask debug)
### Fixed
- Made some endpoint calls a little safer with try/catch to stop errors from killing the process

## [0.0.5] - 2019-12-22
### Added
- NeDB support
### Fixed
- CSS call looking for mapping file removed
- Date/time select on schedule screen might not have had the correct mimetype, thus not appeared in some instances

## [0.0.4] - 2019-12-22
### Added
- Script type identifier to the script tree view
### Fixed
- Prevent catch-up jobs from running every minute on long running schedules when a node is offline for a period of time.
- Check for scheduled jobs 1 minute in the future to prevent schedules running 1 minute behind intended time.

## [0.0.3] - 2019-12-20
### Fixed
- Typo causing installs to think Mongo is not in use

## [0.0.2] - 2019-12-20
### Added
- Suppressed errors and made a nice error message for those without MongoDB (currently unsupported)

## [0.0.1] - 2019-12-20
### Added
- Released initial version
