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
plugin API of Corvus GCS. Corvus compiles its plugins in: there is no loader
and no JavaScript, so the plugin works the same on every platform Corvus is
built for.

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

## Build

Corvus GCS carries this repository as a submodule at
`plugins/trajectory-viewer`:

```bash
git clone --recurse-submodules https://github.com/M-BSquared/CorvusGCS.git
```

In a checkout that was cloned without it:

```bash
git submodule update --init plugins/trajectory-viewer
```

Then `./run.sh` in the Corvus checkout builds and runs Corvus with the plugin.
It is on the PLUGINS tab.

## Tests

From the Corvus checkout:

```bash
cargo test -p corvus_plugin_trajectory_viewer
```

## Licence

Sustainable Use License, see [LICENSE.md](LICENSE.md). Copyright (c) 2026
Maximilian Böck.
