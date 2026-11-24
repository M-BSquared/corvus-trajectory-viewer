//! Trajectory Viewer: a trajectory from a file, drawn on the Home map
//! (`trajectory-viewer.js` of the web plugin).
//!
//! The file is plain text with one point per line, two or three numbers each:
//! x, y and optionally z. Commas, semicolons, tabs or blanks separate them; a
//! semicolon or tab file may write decimals with a comma. Empty lines, lines
//! starting with `#`, `//` or `%`, and a header line are passed over. What the
//! numbers mean is the operator's choice, because a file does not say:
//!
//! * `wgs84`: WGS84 / EPSG:4326 in the order GIS tools write it, x is
//!   longitude and y is latitude, both in degrees.
//! * `gps`: the order a GPS receiver or a phone shows, latitude first.
//! * `utm`: projected metres (easting, northing) in a selectable UTM zone.
//! * `local`: metres in a frame of the aircraft's own. It is 0, 0, 0, x points
//!   the way its nose points, y to its right (FRD, as PX4 has it, z down) or
//!   to its left (FLU, as ROS has it, z up). The frame is taken from the
//!   aircraft's position and heading when the operator anchors it, and stays
//!   there.
//!
//! The line stays on the map when the plugin is closed and comes back after a
//! restart. While the aircraft is armed its own track is recorded with its
//! heights, and **Compare in 3D** draws both and says how far apart they are.

pub mod model;
mod view;

use eframe::egui;
use serde_json::Value;

use corvus_api::data::units::Units;
use corvus_api::net::bg::Pending;
use corvus_api::plugin::shapes::{hex, Style};
use corvus_api::plugin::{Host, Info, Plugin, Reply};
use corvus_api::ui::message::Tone;

use model::{Anchor, Enu, LngLat, Point, Settings};

/// The key of the line among this plugin's shapes.
pub const LINE_KEY: &str = "trajectory";

pub struct Trajectory {
    pub(crate) settings: Settings,
    pub(crate) points: Vec<Point>,
    /// The aircraft's own track while armed: `[lng, lat, altitude AMSL]`.
    pub(crate) flown: Vec<Enu>,
    /// Where the aircraft is now, if it has a position.
    pub(crate) fix: Option<Anchor>,
    pub(crate) status: Option<(String, Tone)>,
    pub(crate) units: Units,
    config: Option<Reply>,
    saving: Vec<Reply>,
    pub(crate) compare: Option<view::Compare>,
}

impl Default for Trajectory {
    fn default() -> Trajectory {
        Trajectory {
            settings: Settings::from_value(&Value::Null),
            points: Vec::new(),
            flown: Vec::new(),
            fix: None,
            status: None,
            units: Units::default(),
            config: None,
            saving: Vec::new(),
            compare: None,
        }
    }
}

impl Trajectory {
    pub(crate) fn say(&mut self, text: impl Into<String>, tone: Tone) {
        self.status = Some((text.into(), tone));
    }

    /// The points on the globe, or why they cannot be put there.
    pub(crate) fn coords(&self) -> Result<Vec<LngLat>, String> {
        model::to_lnglat(
            &self.points,
            &self.settings.frame,
            self.settings.anchor.as_ref(),
            &self.settings.axes,
            &self.settings.utm_zone,
        )
    }

    /// Puts the line on the Home map (`drawSaved`); the reason when it cannot.
    fn draw(&self, h: &mut Host) -> Result<(), String> {
        if self.points.len() < 2 {
            return Err("There is no trajectory to draw. Choose a file first.".into());
        }
        let coords = self.coords()?;
        let color = hex(self.settings.color_hex()).unwrap_or(egui::Color32::LIGHT_BLUE);
        if h.map().line(LINE_KEY, &coords, Style::color(color), Some(4.0), false) {
            Ok(())
        } else {
            Err("The map did not take the line.".into())
        }
    }

    /// Keeps the settings as they are now.
    pub(crate) fn save(&mut self, h: &mut Host) {
        self.saving.push(h.save_settings(&self.settings.to_value(), true));
    }

    /// After a change to what the line is made of (`update`): the line on the
    /// map follows, or leaves it with the reason when it can no longer be
    /// drawn. A local frame that is on the map without an anchor takes the
    /// aircraft's position as one.
    pub(crate) fn changed(&mut self, h: &mut Host) {
        if self.settings.drawn && self.settings.frame == "local" && self.settings.anchor.is_none() {
            self.settings.anchor = self.fix;
        }
        if self.settings.drawn {
            match self.draw(h) {
                Ok(()) => self.status = None,
                Err(why) => {
                    h.map().remove(LINE_KEY);
                    self.settings.drawn = false;
                    self.say(why, Tone::Err);
                }
            }
        }
        self.save(h);
    }

    /// The switch that shows the line on the Home map.
    pub(crate) fn set_on_map(&mut self, on: bool, h: &mut Host) {
        if !on {
            h.map().remove(LINE_KEY);
            self.settings.drawn = false;
            self.status = None;
            self.save(h);
            return;
        }
        let had_anchor = self.settings.anchor;
        if self.settings.frame == "local" && self.settings.anchor.is_none() {
            self.settings.anchor = self.fix;
        }
        match self.draw(h) {
            Ok(()) => {
                self.settings.drawn = true;
                self.status = None;
                self.save(h);
            }
            Err(why) => {
                let no_fix = self.settings.frame == "local" && self.settings.anchor.is_none();
                self.settings.anchor = had_anchor;
                self.say(
                    if no_fix {
                        "No aircraft position yet. Connect and wait for a GPS fix, then anchor the frame.".to_string()
                    } else {
                        why
                    },
                    Tone::Err,
                );
            }
        }
    }

    /// Takes the line off the map and forgets the file.
    pub(crate) fn clear(&mut self, h: &mut Host) {
        h.map().remove(LINE_KEY);
        self.points.clear();
        self.settings.file.clear();
        self.settings.points.clear();
        self.settings.drawn = false;
        self.settings.anchor = None;
        self.status = None;
        self.save(h);
    }

    /// Reads `text`, the content of the file called `name` (the file input's
    /// `change`). A file that cannot be read as a trajectory changes nothing.
    pub(crate) fn take_file(&mut self, name: &str, text: &str, h: &mut Host) {
        let parsed = model::parse_trajectory(text);
        if !parsed.error.is_empty() {
            self.say(format!("{name}: {}", parsed.error), Tone::Err);
            return;
        }
        let mut notes = Vec::new();
        if parsed.skipped > 0 {
            notes.push(format!(
                "{} line{} passed over (the first is line {}).",
                parsed.skipped,
                if parsed.skipped == 1 { " was" } else { "s were" },
                parsed.first_skipped
            ));
        }
        if parsed.thinned {
            notes.push(format!(
                "The file has {} points. One in every {} is drawn.",
                parsed.total,
                parsed.total.div_ceil(model::MAX_POINTS)
            ));
        }
        self.points = parsed.points;
        self.settings.file = name.to_string();
        self.settings.points = model::encode_points(&self.points);
        let drawn = self.settings.drawn;
        self.changed(h);
        // a line that could not be redrawn has said why already
        if !notes.is_empty() && (!drawn || self.settings.drawn) {
            self.say(notes.join(" "), Tone::Warn);
        }
    }

    /// The line under the file: how many points, how long, which heights.
    pub(crate) fn summary(&self) -> String {
        if self.points.is_empty() {
            return String::new();
        }
        let n = self.points.len();
        let mut parts = vec![format!("{n} point{}", if n == 1 { "" } else { "s" })];
        if let Ok(coords) = self.coords() {
            parts.push(format!(
                "{} long",
                self.units.format_distance(model::path_length(&coords))
            ));
        }
        if let Some((lo, hi)) = model::height_range(&self.points, &self.settings.frame, &self.settings.axes) {
            parts.push(format!(
                "heights {} to {}",
                self.units.format_length(lo, 0, false, false),
                self.units.format_length(hi, 0, false, false)
            ));
        }
        format!("{}.", parts.join(", "))
    }
}

impl Plugin for Trajectory {
    fn info(&self) -> Info {
        Info {
            id: "trajectory-viewer",
            name: "Trajectory Viewer",
            icon: "spline",
            description: "Draws a trajectory from a file on the Home map, under the flown track",
            version: "2.0.0",
            order: 40,
            can_tab: false,
        }
    }

    fn start(&mut self, h: &mut Host) {
        self.settings = Settings::from_value(&h.settings());
        self.points = model::decode_points(&self.settings.points);
        if self.settings.drawn {
            // A saved line that can no longer be drawn stays off, silently:
            // nobody is looking at the plugin yet.
            let _ = self.draw(h);
        }
    }

    fn tick(&mut self, h: &mut Host) {
        model::record_flown(&mut self.flown, h.state);
        self.fix = model::anchor_from_state(h.state, h.now * 1000.0);
        if let Some(Ok(cfg)) = self.config.as_ref().and_then(Pending::take) {
            self.units = Units::from_config(&cfg);
            self.config = None;
        }
        let mut failed = None;
        self.saving.retain(|s| match s.take() {
            None => true,
            Some(Ok(_)) => false,
            Some(Err(e)) => {
                failed = Some(e);
                false
            }
        });
        if let Some(e) = failed {
            self.say(
                if e.is_empty() {
                    "Could not save the settings.".to_string()
                } else {
                    e
                },
                Tone::Err,
            );
        }
    }

    fn open(&mut self, h: &mut Host) {
        // the units the operator reads lengths in
        self.config = Some(h.get("/api/config"));
    }

    fn show(&mut self, ui: &mut egui::Ui, area: egui::Rect, h: &mut Host) -> f32 {
        view::show(self, ui, area, h)
    }

    fn close(&mut self, _h: &mut Host) {
        self.compare = None;
        self.status = None;
    }
}

/// The language files of this plugin, for the translation layer.
pub const LANG: &[(&str, &str)] = &[
    ("de", include_str!("../lang/de.json")),
    ("fr", include_str!("../lang/fr.json")),
    ("dl", include_str!("../lang/dl.json")),
];

/// One instance of the plugin, for the registry.
pub fn plugin() -> Box<dyn Plugin> {
    Box::new(Trajectory::default())
}

corvus_api::export_plugin!(plugin, LANG);

#[cfg(test)]
mod tests {
    #[test]
    fn the_details_the_store_lists_are_the_plugins_own() {
        let manifest = include_str!("../Cargo.toml").replace('\r', "");
        let i = plugin().info();
        for (key, want) in [
            ("name", i.name),
            ("description", i.description),
            ("icon", i.icon),
            ("version", i.version),
        ] {
            assert!(
                manifest.contains(&format!("\n{key} = \"{want}\"\n")),
                "[package.metadata.corvus] says something else than the plugin for {key}"
            );
        }
    }

    use super::*;
    use corvus_api::net::http::Server;
    use corvus_api::plugin::bus::Bus;
    use corvus_api::plugin::shapes::ShapeSet;
    use corvus_api::plugin::Outbox;
    use serde_json::{json, Map};

    /// Runs `f` with a host, as the registry does; the shapes stay for the test.
    fn with_host<R>(shapes: &mut ShapeSet, state: &Value, f: impl FnOnce(&mut Host) -> R) -> R {
        let ctx = egui::Context::default();
        let server = Server::local(1);
        let (mut saved, opts, mut out) = (json!({}), Map::new(), Outbox::default());
        let mut bus = Bus::default();
        let info = Trajectory::default().info();
        let mut host = Host::new(
            &ctx, &server, state, info, shapes, &mut saved, &opts, &mut out, &mut bus,
        );
        f(&mut host)
    }

    #[test]
    fn a_file_is_taken_drawn_and_cleared() {
        let mut shapes = ShapeSet::new("trajectory-viewer");
        let mut t = Trajectory::default();
        let state = json!({});
        with_host(&mut shapes, &state, |h| {
            t.take_file("route.csv", "lon,lat\n11.5,48.1\n11.6,48.2\n", h);
            assert_eq!(t.points.len(), 2);
            assert_eq!(t.settings.file, "route.csv");
            assert_eq!(t.status, None);
            assert!(t.summary().starts_with("2 points, "), "{}", t.summary());
            t.set_on_map(true, h);
            assert!(t.settings.drawn);
        });
        assert!(shapes.has(LINE_KEY));
        with_host(&mut shapes, &state, |h| {
            // A frame the numbers do not fit takes the line off, and says why.
            t.settings.frame = "utm".into();
            t.changed(h);
            assert!(!t.settings.drawn);
            assert!(t
                .status
                .as_ref()
                .is_some_and(|(m, tone)| m.starts_with("These numbers are not UTM metres.") && *tone == Tone::Err));
        });
        assert!(!shapes.has(LINE_KEY));
        with_host(&mut shapes, &state, |h| {
            t.settings.frame = "wgs84".into();
            t.set_on_map(true, h);
            t.clear(h);
            assert!(t.points.is_empty() && t.settings.file.is_empty() && !t.settings.drawn);
        });
        assert!(!shapes.has(LINE_KEY));
    }

    #[test]
    fn a_file_that_is_no_trajectory_changes_nothing() {
        let mut shapes = ShapeSet::new("trajectory-viewer");
        let mut t = Trajectory::default();
        with_host(&mut shapes, &json!({}), |h| {
            t.take_file("good.txt", "1 2\n3 4\n", h);
            t.take_file("bad.txt", "hello\nworld\n", h);
        });
        assert_eq!(t.settings.file, "good.txt");
        assert_eq!(t.points.len(), 2);
        assert_eq!(
            t.status.as_ref().map(|s| s.0.as_str()),
            Some("bad.txt: No points found. Each line needs two or three numbers: x, y and optionally z.")
        );
    }

    #[test]
    fn skipped_lines_are_said() {
        let mut shapes = ShapeSet::new("trajectory-viewer");
        let mut t = Trajectory::default();
        with_host(&mut shapes, &json!({}), |h| t.take_file("r.txt", "1 2\noops\n3 4\n", h));
        assert_eq!(
            t.status,
            Some(("1 line was passed over (the first is line 2).".into(), Tone::Warn))
        );
    }

    #[test]
    fn the_local_frame_needs_the_aircraft_and_takes_it_as_the_anchor() {
        let mut shapes = ShapeSet::new("trajectory-viewer");
        let mut t = Trajectory::default();
        let state = json!({"connected": true, "position": [11.5, 48.1], "heading": 90.0});
        with_host(&mut shapes, &state, |h| {
            t.settings.frame = "local".into();
            t.take_file("local.txt", "0 0 0\n100 0 -10\n", h);
            t.set_on_map(true, h);
            assert!(!t.settings.drawn);
            assert_eq!(
                t.status.as_ref().map(|s| s.0.as_str()),
                Some("No aircraft position yet. Connect and wait for a GPS fix, then anchor the frame.")
            );
            t.tick(h);
            assert!(t.fix.is_some());
            t.set_on_map(true, h);
            assert!(t.settings.drawn, "{:?}", t.status);
            assert_eq!(t.settings.anchor.map(|a| a.heading), Some(90.0));
        });
        assert!(shapes.has(LINE_KEY));
        assert_eq!(model::height_range(&t.points, "local", "frd"), Some((0.0, 10.0)));
    }

    #[test]
    fn a_saved_line_comes_back_at_the_start() {
        let mut shapes = ShapeSet::new("trajectory-viewer");
        let ctx = egui::Context::default();
        let server = Server::local(1);
        let mut saved = json!({"file": "r.txt", "points": "11.5 48.1\n11.6 48.2", "drawn": true, "color": "orange"});
        let (opts, mut out, state) = (Map::new(), Outbox::default(), json!({}));
        let mut bus = Bus::default();
        let mut t = Trajectory::default();
        let info = t.info();
        let mut h = Host::new(
            &ctx,
            &server,
            &state,
            info,
            &mut shapes,
            &mut saved,
            &opts,
            &mut out,
            &mut bus,
        );
        t.start(&mut h);
        assert_eq!((t.points.len(), t.settings.color.as_str()), (2, "orange"));
        assert!(shapes.has(LINE_KEY));
    }
}
