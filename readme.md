# MeshCentral-ScriptTask

A script running plugin for the [MeshCentral2](https://github.com/Ylianst/MeshCentral) Project. The plugin supports PowerShell, BAT, and Bash scripts. Windows, MacOS, and Linux endpoints are all supported. PowerShell can be run on any OS that has PowerShell installed, not just Windows.

## About this fork
Community fork of [ryanblenis/MeshCentral-ScriptTask](https://github.com/ryanblenis/MeshCentral-ScriptTask), which is no longer updated. 0.1.x fixes scripts being run repeatedly, temp files piling up in the MeshAgent folder, and long-running scripts losing their status. It also adds folder organisation (drag and drop, Move, ordering), export/import of scripts as an editable zip, a full-window tab, and upgrades from the Plugins page without restarting MeshCentral. See [changelog.md](changelog.md) for details.

**How this fork was made and tested.** The 0.1.x changes were written with AI assistance (Claude) and reviewed by the maintainer. Testing:
- Automated tests ran against the real plugin code on **NeDB**: job dispatch and de-duplication, a simulated MeshAgent, the script tree UI in Chromium, export/import round trips, and in-place upgrades.
- The **MongoDB** code was reviewed but not covered by automated tests. It is in day-to-day use on the maintainer's MongoDB server.
- The agent side has been used on **Windows** endpoints. Linux and macOS agents use the same code paths but have had less real-world use.

Use at your own risk. If you hit a problem, please open an issue and say whether you use MongoDB or NeDB and which agent OS.

## Permissions
- ScriptTask is for **full MeshCentral administrators** only. Other users don't see the tab, and the server rejects their requests.
- Running or scheduling a script on a device also requires the **remote command** right on that device.
- Devices (agents) can only fetch scripts for jobs queued for them and report results.

## Releasing (maintainers)
`sh release.sh 0.1.5` sets `version` and the tag-pinned `downloadUrl` in `config.json`, dates the `[Unreleased]` changelog entry, commits and tags. Then `git push origin master --tags` and use **Upgrade** in MeshCentral.

## Export / Import
- **Export** (toolbar) downloads `scripttask-export-<date>.zip` with every script as a normal file, in folders matching the script tree. Characters Windows can't use in file names are replaced with `_`; the real names are kept in `scripttask-export.json`, so leave that file in the zip.
- Edit, add or re-arrange files offline, then **Import** the zip. You get a preview first (including a warning for scripts changed on the server since the export). After you confirm, matching scripts are updated, new files and folders are added, and nothing is deleted. Files that aren't `.ps1`, `.bat`, `.cmd` or `.sh` are skipped.
- A file renamed offline is imported as a new script (the old one stays), because it no longer matches by name.

## Important Note
**This plugin now supports NeDB and MongoDB**

## Installation

 Pre-requisite: First, make sure you have plugins enabled for your MeshCentral installation:
>     "plugins": {
>          "enabled": true
>     },
Restart your MeshCentral server after making this change.

 To install, simply add the plugin configuration URL when prompted:
 `https://raw.githubusercontent.com/jbrown250/MeshCentral-ScriptTask/master/config.json`

## Features
- Add scripts to a central store
- Run scripts on single or multiple endpoints simultaneously
-- Supports PowerShell, BAT, and Bash scripts
- Review the return status / value of completed scripts
-- Returns text or parses returned JSON for easy viewing
- Schedule scripts for future runs on either a one-time or interval basis (minutes, hourly, daily, weekly)
- View schedules and histories based on either node (endpoint) or script
- Dead job detection with script replay

## Usage Notes
- *Run* schedules and runs the job instantly.
- *Schedule* puts the events into a queue.
- Queues are checked / run every minute.
- Scheduled jobs only show the *next* scheduled job at any given time.
- History is limited to 200 events per node/script in the viewport.
- Historical events that have completed will delete after 90 days.
- Jobs only run when the endpoint agent is online. They do *not* queue to the agent when offline, then run at the specified time.
- Scripts are cached on the clients and verified via hash at runtime for the latest version.

## Variables
- Variables can be assigned to the following scopes: Global, Script, Mesh, and Node
- Variables with the same name will override each other in the above order (ex. Global variable testVariable will be overridden by Script variable testVariable will be overridden by Mesh variable Test will be overridden by Node variable testVariable if they exist and apply to the node running the script)
- Variables found in a script which do not correspond with a defined variable will be replaced with VAR_NOT_FOUND
- Variables are assigned during job dispatch (e.g. when the job is sent to the node), so the latest script and variable values will be accounted for, should they have changed since a job or scheduled job were defined.
- Variables in scripts must be defined by hashtags on both sides and not contain spaces. (E.g. #myVar#)

## Getting Started
Drag and drop some of your favorite admin scripts on the file tree. You'll then be able to run them immediately on endpoints (nodes).

## Upcoming Features
- Take action on the results of a script
- Variable replacement

## Other Information
This is fairly new and in beta. Testing was mostly done in the latest Chrome and Firefox. No attempt was made to be compatible with older IE browsers. Endpoint testing was done on Windows 10 (1903) and OS X 10.13.

## Screenshots
![Device Page](https://user-images.githubusercontent.com/1929277/71248033-f4519b00-22e7-11ea-9aa6-ef22e0b9fdb2.png)
![Script Editor](https://user-images.githubusercontent.com/1929277/71248034-f4519b00-22e7-11ea-8ab4-ccad3e959a1a.png)
![Schedule Screen](https://user-images.githubusercontent.com/1929277/71248469-e7817700-22e8-11ea-9121-a215de160e0e.png)

