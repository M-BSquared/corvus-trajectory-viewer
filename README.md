# Trajectory Viewer for Corvus GCS

A plugin for [Corvus GCS](https://github.com/M-BSquared/CorvusGCS), the
offline ground control station for PX4 and ArduPilot.

It draws a trajectory from a file on the Home map: a route someone planned
elsewhere, a survey pattern, or yesterday's flight, as a reference to fly
against. The line lies under the flown track, so while the aircraft flies its
own path is always on top and you see at a glance where it leaves the
reference. **Compare in 3D** draws the trajectory and the flown track in one
view you can turn and zoom, with the largest and the average distance between
them.

The file is plain text, one point per line, in WGS84 (longitude, latitude),
GPS order (latitude, longitude), UTM metres (zones 31N to 35N, among them
EPSG:32632, 25832 and 32633) or metres in the aircraft's own frame.

The full description is in the
[Corvus guide](https://m-bsquared.github.io/CorvusGCS/guide/plugins.html#trajectory-viewer).

## What it is

A Rust crate (`corvus_plugin_trajectory_viewer`) built on `corvus_api`, the
plugin API of Corvus GCS. It is not part of the program: it is published as a shared
library from this repository and installed from Settings, Plugins. There is no JavaScript.

- `src/model.rs`: the rules, free of the interface: reading a file, the
  conversions to longitude and latitude (UTM by the Krüger series, the local
  frame), the flown track and its distance from the trajectory, the saved
  settings. Its tests hold the conversions to what the web plugin answered.
- `src/lib.rs`: the plugin: the line on the map, what a change does to it,
  what is saved.
- `src/view.rs`: the card and the 3D comparison, drawn by the plugin itself.
- `lang/`: German, French and the dialect file.

The web plugin this replaces (`trajectory-viewer.js`, its stylesheet, its
tests and the Plotly bundle under `vendor/`) is no longer loaded by Corvus.
The Rust crate needs none of it.

## Change it

Corvus GCS carries this repository as a submodule at `plugins/trajectory-viewer`, and the
crate is a member of its workspace:

```bash
git clone --recurse-submodules https://github.com/M-BSquared/CorvusGCS.git
cd CorvusGCS
./run.sh
```

Settings, Plugins then offers the copy built there. A dependency must be one
that `Cargo.lock` of Corvus GCS already holds.

## Publish it

Commit, then:

```bash
./release.sh
```

It runs the tests and pushes `main`. The workflow builds the plugin for the
newest published Corvus GCS on Linux, macOS and Windows, lets that program load
it, and attaches it to the release `abi-<sum>` of this repository, where every
Corvus GCS with the same plugin interface finds it. A Corvus GCS with a new
interface gets its build within hours. With nothing to push, `./release.sh`
starts that build at once. `--watch` waits for the result, `--help` lists the
rest.

## Tests

From the Corvus checkout:

```bash
cargo test -p corvus_plugin_trajectory_viewer
```

## Licence

Sustainable Use License, see [LICENSE.md](LICENSE.md). Copyright (c) 2026
Maximilian Böck.
