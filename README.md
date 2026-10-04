# Trajectory Viewer for Corvus GCS

A plugin for [Corvus GCS](https://github.com/M-BSquared/CorvusGCS), the
offline ground control station for PX4 and ArduPilot.

It draws a trajectory from a file on the Home map: a route someone planned
elsewhere, a survey pattern, or yesterday's flight, as a reference to fly
against. The line lies under the flown track, so while the aircraft flies its
own path is always on top and you see at a glance where it leaves the
reference.

The file is plain text, one point per line, in WGS84 (longitude, latitude),
GPS order (latitude, longitude), UTM metres (EPSG:32632, 25832, 32633) or metres in the aircraft's own frame.

The full description is in the
[Corvus guide](https://m-bsquared.github.io/CorvusGCS/guide/plugins.html#trajectory-viewer).

## What it needs

- Corvus GCS newer than 2026.10.03, the first with `api.map` and start hooks
  for plugins.

## Install

1. Download this repository: **Code, Download ZIP**, or `git clone`.
2. In Corvus, open **Settings, Plugins, Open plugin folder**.
3. Put the folder there and name it `trajectory-viewer`. That is the folder its
   settings are kept in.
4. Restart Corvus. The plugin is on the PLUGINS tab.

With git, in one step:

```bash
git clone https://github.com/M-BSquared/corvus-trajectory-viewer.git ~/.corvus/plugins/trajectory-viewer
```

On Windows the plugin folder is `%USERPROFILE%\.corvus\plugins`.

## Update

Replace the folder's files with the new ones and restart Corvus, or run
`git pull` inside it. Keep `config.json`: it holds the plugin's settings.

## Tests

The tests in `tests/` run against Corvus's own scripts, so they need a Corvus
checkout. Inside one, with this plugin in `plugins/trajectory-viewer/`, Corvus runs them
with its own:

```bash
node tools/frontend_tests.js
```

Anywhere else, point them at the checkout:

```bash
CORVUS_ROOT=/path/to/CorvusGCS node tests/test_trajectory_viewer.js
```

## Licence

Sustainable Use License, see [LICENSE.md](LICENSE.md). Copyright (c) 2026
Maximilian Böck.
