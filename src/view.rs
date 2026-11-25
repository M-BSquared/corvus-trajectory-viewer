//! What the operator sees: the one card (the file, what its numbers mean, the
//! colour, the switches and the buttons) and the 3D comparison with the flown
//! track (`init` and `showComparison` of `trajectory-viewer.js`).

use corvus_api::egui::{self, Color32, Pos2, Rect, Stroke, Vec2};

use corvus_api::plugin::shapes::hex;
use corvus_api::plugin::Host;
use corvus_api::ui::filepicker::{self, Filter};
use corvus_api::ui::form::{self, Form};
use corvus_api::ui::kit::{Button, Choice, Variant};
use corvus_api::ui::message::Tone;
use corvus_api::ui::style::{self, Weight};
use corvus_api::ui::tip::HoverTr;
use corvus_api::ui::{formfield, kit, modal};

use crate::model::{self, Enu, AXES, COLORS, FRAMES, UTM_ZONES};
use crate::Trajectory;

const FLOWN_COLOR: Color32 = Color32::from_rgb(0xFF, 0x3B, 0x30);
const VIEW_HINT: &str = "Drag to turn, scroll to zoom.";

/// The 3D comparison while it is open.
pub struct Compare {
    reference: Vec<Enu>,
    flown: Vec<Enu>,
    /// `(largest, mean)` distance of the flown track from the trajectory.
    deviation: Option<(f64, f64)>,
    amsl: bool,
    color: Color32,
    yaw: f32,
    pitch: f32,
    zoom: f32,
}

fn choices(list: &[(&str, &str)]) -> Vec<Choice> {
    list.iter().map(|(id, label)| Choice::new(*id, *label)).collect()
}

/// "Anchored at ..., heading ...": where the local frame is fixed.
pub fn format_anchor(anchor: Option<&model::Anchor>, offset_s: i64) -> String {
    let Some(a) = anchor else {
        return "Not anchored yet.".into();
    };
    let time = if a.at > 0.0 {
        let (_, _, _, hh, mm, _) = corvus_api::data::clock::civil((a.at / 1000.0) as i64 + offset_s);
        format!(" (taken {hh:02}:{mm:02})")
    } else {
        String::new()
    };
    format!(
        "Anchored at {:.6}, {:.6}, heading {}\u{b0}{time}.",
        a.lat,
        a.lon,
        a.heading.round()
    )
}

pub fn show(t: &mut Trajectory, ui: &mut egui::Ui, area: Rect, h: &mut Host) -> f32 {
    let mut f = Form::new(area.left(), area.top(), area.width());
    let has_points = t.points.len() >= 2;

    // ---- the file (on top: everything below works on it) ----
    let mut chosen = false;
    let file_name = if t.settings.file.is_empty() {
        "No file chosen".to_string()
    } else {
        t.settings.file.clone()
    };
    form::field(
        ui,
        &mut f,
        "File",
        "One point per line: x, y and optionally z, separated by commas, semicolons, tabs or spaces. A file with semicolons or tabs may write decimals with a comma.\nEmpty lines, a header line such as lon,lat,alt, and lines starting with #, // or % are passed over.",
        "",
        |ui, x, y, w| {
            let b = Button::new("Choose file\u{2026}", Variant::Secondary).icon("folder-open");
            let (bw, bh) = (b.width(ui), b.height());
            chosen = b.show(ui, Rect::from_min_size(Pos2::new(x, y), Vec2::new(bw, bh)), "tv-choose");
            let g = corvus_api::ui::text::clamped(
                ui,
                &file_name,
                12.0,
                Weight::W400,
                style::text_2(),
                0.0,
                (w - bw - 10.0).max(40.0),
                1,
                None,
            );
            ui.painter().galley(
                Pos2::new(x + bw + 10.0, y + (bh - g.size().y) / 2.0),
                g,
                style::text_2(),
            );
            bh
        },
    );
    if chosen {
        choose_file(t, h);
    }
    let summary = t.summary();
    if !summary.is_empty() {
        f.skip(8.0);
        form::message(ui, &mut f, &summary, Tone::Plain);
    }

    // ---- what the numbers mean ----
    f.skip(14.0);
    let mut picked: Option<String> = None;
    form::field(
        ui,
        &mut f,
        "Coordinates",
        "What the numbers in the file mean. A file does not say, so you choose.\nWGS84 / EPSG:4326: degrees, x is longitude and y is latitude, the order GIS tools write (GeoJSON, QGIS).\nUTM: metres, x is easting and y is northing with selectable zone (zone 32N covers Munich).\nGPS: degrees, latitude first, then longitude, the order a GPS receiver or a phone shows.\nLocal frame: metres from the aircraft, along the way it faces.",
        "",
        |ui, x, y, w| {
            picked = formfield::select(ui, x, y, w, &choices(&FRAMES), &t.settings.frame, "tv-frame");
            formfield::control_h()
        },
    );
    if let Some(frame) = picked {
        t.settings.frame = frame;
        t.changed(h);
    }
    if t.settings.frame == "utm" {
        f.skip(12.0);
        let zones: Vec<(&str, &str)> = UTM_ZONES.iter().map(|z| (z.0, z.1)).collect();
        let mut picked: Option<String> = None;
        form::field(
            ui,
            &mut f,
            "Zone",
            "UTM zone covering your survey area.\nZone 32N covers Munich and Western Germany; Zone 33N covers Eastern Germany.",
            "",
            |ui, x, y, w| {
                picked = formfield::select(ui, x, y, w, &choices(&zones), &t.settings.utm_zone, "tv-zone");
                formfield::control_h()
            },
        );
        if let Some(zone) = picked {
            t.settings.utm_zone = zone;
            t.changed(h);
        }
    }
    if t.settings.frame == "local" {
        f.skip(12.0);
        let mut picked: Option<String> = None;
        form::field(
            ui,
            &mut f,
            "Axes",
            "The aircraft is 0, 0, 0 and x points the way its nose points.\ny to the right is FRD, as PX4 has it: z points down, so a height of 10 m is z = -10. y to the left is FLU, as ROS has it: z points up.\nThe frame is fixed where the aircraft is and the way it faces when you anchor it (or turn the line on without an anchor), and stays there while it flies. Anchor again to move it to the aircraft.",
            "",
            |ui, x, y, w| {
                picked = formfield::select(ui, x, y, w, &choices(&AXES), &t.settings.axes, "tv-axes");
                formfield::control_h()
            },
        );
        if let Some(axes) = picked {
            t.settings.axes = axes;
            t.changed(h);
        }
        f.skip(8.0);
        let text = format_anchor(t.settings.anchor.as_ref(), corvus_api::data::clock::local_offset());
        let g = kit::wrapped_weight(ui, &text, 11.5, Weight::W400, style::text_2(), f.w, 1.4);
        ui.painter().galley(Pos2::new(f.x, f.y), g.clone(), style::text_2());
        f.skip(g.size().y + 8.0);
        let title = if t.fix.is_some() {
            "Take the aircraft's position and heading as 0, 0, 0 now"
        } else {
            "No aircraft position yet. Connect and wait for a GPS fix."
        };
        let anchor = Button::new("Anchor at the aircraft", Variant::Secondary)
            .icon("locate-fixed")
            .enabled(t.fix.is_some())
            .title(title);
        if form::actions(ui, &mut f, vec![anchor]) == Some(0) && t.fix.is_some() {
            t.settings.anchor = t.fix;
            t.status = None;
            t.changed(h);
        }
    }

    // ---- the colour ----
    f.skip(14.0);
    let mut colour: Option<&str> = None;
    form::field(ui, &mut f, "Colour", "", "", |ui, x, y, _w| {
        for (i, (id, label, value)) in COLORS.iter().enumerate() {
            let r = Rect::from_min_size(Pos2::new(x + i as f32 * 34.0, y), Vec2::splat(26.0));
            let resp = ui
                .interact(r, ui.scope_id().with(("tv-swatch", i)), egui::Sense::click())
                .on_hover_tr(label);
            let c = hex(value).unwrap_or(Color32::GRAY);
            ui.painter().circle_filled(r.center(), 9.0, c);
            if t.settings.color == *id {
                ui.painter()
                    .circle_stroke(r.center(), 12.0, Stroke::new(2.0, style::accent()));
            } else if resp.hovered() {
                ui.painter()
                    .circle_stroke(r.center(), 12.0, Stroke::new(1.0, style::border_strong()));
            }
            if resp.clicked() {
                colour = Some(id);
            }
        }
        26.0
    });
    if let Some(id) = colour {
        t.settings.color = id.to_string();
        t.changed(h);
    }

    // ---- the switches ----
    f.skip(14.0);
    let on_map = form::Switch::new("Show on the Home map", "", t.settings.drawn).info(
        "Drawn under the flown track, so the aircraft's own path stays on top where the two cross.\nThe line stays on the map when you close this plugin, and comes back after a restart, until you switch it off.",
    );
    if let Some(on) = form::switch_field(ui, &mut f, "tv-onmap", on_map, style::text_1(), 12.5) {
        t.set_on_map(on, h);
    }
    let amsl = form::Switch::new("Heights in AMSL (3D)", "", t.settings.amsl).info(
        "Off: both tracks start at height 0 and show the climb from there.\nOn: the flown track is drawn at its altitude AMSL and the file's heights as written, for a file whose z is AMSL too.",
    );
    if let Some(on) = form::switch_field(ui, &mut f, "tv-amsl", amsl, style::text_1(), 12.5) {
        t.settings.amsl = on;
        t.save(h);
    }

    // ---- the buttons ----
    f.skip(16.0);
    let buttons = vec![
        Button::new("Show me", Variant::Secondary)
            .icon("scan")
            .enabled(has_points)
            .title("Frame the trajectory on the Home map"),
        Button::new("Compare in 3D", Variant::Secondary)
            .icon("box")
            .enabled(has_points)
            .title("Plot the trajectory and the flown track in 3D"),
        Button::new("Clear", Variant::Secondary)
            .icon("trash-2")
            .enabled(has_points || !t.settings.file.is_empty())
            .title("Take the line off the map and forget the file"),
    ];
    match form::actions(ui, &mut f, buttons) {
        Some(0) => match t.coords() {
            Ok(coords) => h.fit(coords),
            Err(why) => t.say(why, Tone::Err),
        },
        Some(1) => open_comparison(t),
        Some(2) => {
            t.clear(h);
            t.compare = None;
        }
        _ => {}
    }
    if let Some((text, tone)) = t.status.clone() {
        f.skip(12.0);
        form::message(ui, &mut f, &text, tone);
    }

    show_comparison(t, ui.ctx());
    f.y - area.top()
}

/// Asks for a file and reads it. The dialog is the system's own.
fn choose_file(t: &mut Trajectory, h: &mut Host) {
    let filter = Filter {
        name: "Trajectory",
        extensions: &["txt", "csv", "tsv", "xyz", "dat", "log"],
    };
    let Some(path) = filepicker::pick_file("Choose a trajectory file", Some(filter), None) else {
        return;
    };
    let name = filepicker::file_name(&path);
    match filepicker::read(&path, model::MAX_FILE_BYTES) {
        Ok(bytes) => t.take_file(&name, &String::from_utf8_lossy(&bytes), h),
        Err(e) if e == filepicker::TOO_LARGE => t.say(
            format!("{name} is larger than {} MB.", model::MAX_FILE_BYTES / 1024 / 1024),
            Tone::Err,
        ),
        Err(_) => t.say("Could not read the file.", Tone::Err),
    }
}

fn open_comparison(t: &mut Trajectory) {
    let coords = match t.coords() {
        Ok(c) => c,
        Err(why) => {
            t.say(why, Tone::Err);
            return;
        }
    };
    if coords.len() < 2 {
        t.say("There is no trajectory to plot. Choose a file first.", Tone::Warn);
        return;
    }
    t.status = None;
    let heights: Vec<f64> = t
        .points
        .iter()
        .map(|p| {
            p.2.map_or(0.0, |z| model::height_of(z, &t.settings.frame, &t.settings.axes))
        })
        .collect();
    let (reference, flown) = model::build_comparison(&coords, &heights, &t.flown, t.settings.amsl);
    let deviation = if flown.len() >= 2 {
        model::deviation(&reference, &flown)
    } else {
        None
    };
    t.compare = Some(Compare {
        reference,
        flown,
        deviation,
        amsl: t.settings.amsl,
        color: hex(t.settings.color_hex()).unwrap_or(Color32::LIGHT_BLUE),
        yaw: -0.75,
        pitch: 0.45,
        zoom: 1.0,
    });
}

fn show_comparison(t: &mut Trajectory, ctx: &egui::Context) {
    let Some(c) = t.compare.as_mut() else { return };
    let has_flown = c.flown.len() >= 2;
    let units = t.units;
    let info = match c.deviation {
        Some((max, mean)) => format!(
            "Largest distance from the trajectory {}, on average {}. {} {VIEW_HINT}",
            units.format_length(max, 1, false, false),
            units.format_length(mean, 1, false, false),
            if c.amsl {
                "Heights are altitude AMSL."
            } else {
                "Heights are above each track's start."
            }
        ),
        None => format!(
            "No flown track yet. It is recorded while the aircraft is armed and then drawn here next to the trajectory. {VIEW_HINT}"
        ),
    };
    let title = if has_flown {
        "Trajectory and flown track"
    } else {
        "Trajectory"
    };
    let mut clear_flown = false;
    let closed = modal::show(ctx, "tv-compare", modal::Size::Lg, title, |ui, x, y, w| {
        let plot = Rect::from_min_size(Pos2::new(x, y), Vec2::new(w, 340.0));
        paint_plot(ui, plot, c, has_flown);
        let g = kit::wrapped_weight(ui, &info, 11.5, Weight::W400, style::text_2(), w, 1.4);
        ui.painter()
            .galley(Pos2::new(x, plot.bottom() + 10.0), g.clone(), style::text_2());
        let mut bottom = plot.bottom() + 10.0 + g.size().y;
        if has_flown {
            let b = Button::new("Clear flown track", Variant::Secondary).icon("trash-2");
            let (hit, end) = modal::actions(ui, x, bottom + 16.0, w, vec![b]);
            clear_flown = hit == Some(0);
            bottom = end;
        }
        bottom
    });
    if clear_flown {
        t.flown.clear();
    }
    if closed || clear_flown {
        t.compare = None;
    }
}

/// A step of 1, 2 or 5 times a power of ten that cuts `range` into about five.
pub fn nice_step(range: f64) -> f64 {
    if !(range.is_finite() && range > 0.0) {
        return 1.0;
    }
    let raw = range / 5.0;
    let mag = 10f64.powf(raw.log10().floor());
    let n = raw / mag;
    mag * if n < 1.5 {
        1.0
    } else if n < 3.5 {
        2.0
    } else if n < 7.5 {
        5.0
    } else {
        10.0
    }
}

/// How many times taller heights are drawn so a climb shows beside a long
/// route: 1 when the heights span a fifth of the ground extent or more, else
/// the round factor (2, 5, 10, ...) that brings them near a quarter of it.
pub fn exaggeration(ground: f64, heights: f64) -> f64 {
    if !(ground.is_finite() && heights.is_finite()) || heights <= 0.0 || heights >= ground / 5.0 {
        return 1.0;
    }
    let want = ground / 4.0 / heights;
    let mag = 10f64.powf(want.log10().floor());
    let n = want / mag;
    (mag * if n < 2.0 {
        1.0
    } else if n < 5.0 {
        2.0
    } else {
        5.0
    })
    .clamp(1.0, 1000.0)
}

/// Lowest and highest of each axis over both tracks.
fn bounds(c: &Compare) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in c.reference.iter().chain(c.flown.iter()) {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    for k in 0..3 {
        if !lo[k].is_finite() || !hi[k].is_finite() {
            (lo[k], hi[k]) = (0.0, 1.0);
        }
        if hi[k] - lo[k] < 1.0 {
            let mid = (hi[k] + lo[k]) / 2.0;
            (lo[k], hi[k]) = (mid - 0.5, mid + 0.5);
        }
    }
    (lo, hi)
}

/// Where a point of the scene lands in the plot: turned by `yaw` about the
/// vertical, looked at from `pitch` above the horizon, without perspective.
pub fn project(p: Enu, centre: [f64; 3], scale: f32, yaw: f32, pitch: f32, mid: Pos2) -> Pos2 {
    let (e, n, u) = (
        (p[0] - centre[0]) as f32,
        (p[1] - centre[1]) as f32,
        (p[2] - centre[2]) as f32,
    );
    let x = e * yaw.cos() - n * yaw.sin();
    let depth = e * yaw.sin() + n * yaw.cos();
    let y = u * pitch.cos() + depth * pitch.sin();
    Pos2::new(mid.x + x * scale, mid.y - y * scale)
}

fn paint_plot(ui: &mut egui::Ui, rect: Rect, c: &mut Compare, has_flown: bool) {
    let painter = ui.painter_at(rect);
    painter.rect_filled(rect, style::RADIUS_BTN, style::surface_1());
    painter.rect_stroke(
        rect,
        style::RADIUS_BTN,
        Stroke::new(1.0, style::border_soft()),
        egui::StrokeKind::Inside,
    );
    let resp = ui.interact(rect, ui.scope_id().with("tv-plot"), egui::Sense::click_and_drag());
    if resp.dragged() {
        let d = resp.drag_delta();
        c.yaw += d.x * 0.01;
        c.pitch = (c.pitch + d.y * 0.01).clamp(0.05, 1.5);
    }
    if resp.hovered() {
        let wheel = ui.input(|i| i.smooth_scroll_delta.y);
        if wheel != 0.0 {
            c.zoom = (c.zoom * (wheel * 0.004).exp()).clamp(0.3, 12.0);
        }
    }

    let (lo, hi) = bounds(c);
    // A climb of a few metres over a route of kilometres would be a flat
    // line: heights are then drawn taller, and the plot says by how much.
    let tall = exaggeration((hi[0] - lo[0]).max(hi[1] - lo[1]), hi[2] - lo[2]);
    let top = lo[2] + (hi[2] - lo[2]) * tall;
    let centre = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + top) / 2.0];
    // the scale at which the box of the scene, seen from here, fills the plot
    let mut reach = Vec2::splat(0.5);
    for e in [lo[0], hi[0]] {
        for n in [lo[1], hi[1]] {
            for u in [lo[2], top] {
                let p = project([e, n, u], centre, 1.0, c.yaw, c.pitch, Pos2::ZERO);
                reach = reach.max(Vec2::new(p.x.abs(), p.y.abs()));
            }
        }
    }
    let room = rect.size() / 2.0 - Vec2::new(64.0, 44.0);
    let scale = (room.x / reach.x).min(room.y / reach.y).max(1e-6) * c.zoom;
    let at = |p: Enu| {
        let drawn = [p[0], p[1], lo[2] + (p[2] - lo[2]) * tall];
        project(drawn, centre, scale, c.yaw, c.pitch, rect.center())
    };

    // the floor: a grid at the lowest height, with metres along two edges
    let grid = Stroke::new(1.0, style::border_soft());
    let step = nice_step((hi[0] - lo[0]).max(hi[1] - lo[1]));
    let floor = lo[2];
    let first = |v: f64| (v / step).ceil() * step;
    let label = |text: String, p: Pos2| {
        let g = style::galley(ui, &text, 9.5, Weight::W400, style::text_3(), 0.0);
        painter.galley(p - g.size() / 2.0, g, style::text_3());
    };
    let mut e = first(lo[0]);
    while e <= hi[0] + 1e-9 {
        painter.line_segment([at([e, lo[1], floor]), at([e, hi[1], floor])], grid);
        label(format!("{e:.0}"), at([e, lo[1] - step * 0.35, floor]));
        e += step;
    }
    let mut n = first(lo[1]);
    while n <= hi[1] + 1e-9 {
        painter.line_segment([at([lo[0], n, floor]), at([hi[0], n, floor])], grid);
        label(format!("{n:.0}"), at([lo[0] - step * 0.35, n, floor]));
        n += step;
    }
    let edge = Stroke::new(1.0, style::border_strong());
    let corners = [
        [lo[0], lo[1], floor],
        [hi[0], lo[1], floor],
        [hi[0], hi[1], floor],
        [lo[0], hi[1], floor],
    ];
    for i in 0..4 {
        painter.line_segment([at(corners[i]), at(corners[(i + 1) % 4])], edge);
    }
    label(
        "East (m)".into(),
        at([(lo[0] + hi[0]) / 2.0, lo[1] - step * 0.9, floor]),
    );
    label(
        "North (m)".into(),
        at([lo[0] - step * 0.9, (lo[1] + hi[1]) / 2.0, floor]),
    );
    // the height axis at one corner
    let zstep = nice_step(hi[2] - lo[2]);
    painter.line_segment([at([lo[0], hi[1], floor]), at([lo[0], hi[1], hi[2]])], edge);
    let mut z = (lo[2] / zstep).ceil() * zstep;
    let mut last_label = f32::INFINITY;
    while z <= hi[2] + 1e-9 {
        let p = at([lo[0], hi[1], z]);
        painter.line_segment([p, p + Vec2::new(-4.0, 0.0)], edge);
        // labels that would sit on each other are left out
        if (last_label - p.y).abs() >= 13.0 {
            label(format!("{z:.0}"), p + Vec2::new(-16.0, 0.0));
            last_label = p.y;
        }
        z += zstep;
    }
    label(
        if c.amsl { "Altitude AMSL (m)" } else { "Height (m)" }.into(),
        at([lo[0], hi[1], hi[2]]) + Vec2::new(0.0, -12.0),
    );

    // the tracks: the line, a drop to the floor at its ends, a dot at the
    // start and a diamond at the end
    let track = |pts: &[Enu], color: Color32| {
        let line: Vec<Pos2> = pts.iter().map(|p| at(*p)).collect();
        painter.add(egui::Shape::line(line.clone(), Stroke::new(2.5, color)));
        let (Some(a), Some(b)) = (pts.first(), pts.last()) else {
            return;
        };
        for p in [a, b] {
            painter.line_segment(
                [at(*p), at([p[0], p[1], floor])],
                Stroke::new(1.0, color.gamma_multiply(0.45)),
            );
        }
        painter.circle_filled(at(*a), 4.5, color);
        let e = at(*b);
        painter.add(egui::Shape::convex_polygon(
            vec![
                e + Vec2::new(0.0, -5.0),
                e + Vec2::new(5.0, 0.0),
                e + Vec2::new(0.0, 5.0),
                e + Vec2::new(-5.0, 0.0),
            ],
            color,
            Stroke::NONE,
        ));
    };
    track(&c.reference, c.color);
    if has_flown {
        track(&c.flown, FLOWN_COLOR);
    }
    if tall > 1.0 {
        let text = corvus_api::i18n::tr_fmt("Heights drawn {a} times taller", &[("a", &format!("{tall:.0}"))]);
        let g = style::galley(ui, &text, 10.0, Weight::W400, style::text_3(), 0.0);
        painter.galley(
            Pos2::new(rect.right() - 12.0 - g.size().x, rect.bottom() - 10.0 - g.size().y),
            g,
            style::text_3(),
        );
    }
    if has_flown {
        // the legend
        let mut x = rect.left() + 12.0;
        for (name, color) in [("Trajectory", c.color), ("Flown", FLOWN_COLOR)] {
            let y = rect.top() + 14.0;
            painter.line_segment([Pos2::new(x, y), Pos2::new(x + 16.0, y)], Stroke::new(2.5, color));
            let g = style::galley(ui, name, 10.5, Weight::W500, style::text_2(), 0.0);
            let w = g.size().x;
            painter.galley(Pos2::new(x + 21.0, y - g.size().y / 2.0), g, style::text_2());
            x += 21.0 + w + 16.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_anchor_is_said_with_its_time() {
        assert_eq!(format_anchor(None, 0), "Not anchored yet.");
        let a = model::Anchor {
            lat: 48.123_456_7,
            lon: 11.5,
            heading: 89.6,
            at: 0.0,
        };
        assert_eq!(
            format_anchor(Some(&a), 0),
            "Anchored at 48.123457, 11.500000, heading 90\u{b0}."
        );
        let timed = model::Anchor {
            at: (13 * 3600 + 5 * 60) as f64 * 1000.0,
            ..a
        };
        assert!(format_anchor(Some(&timed), 3600).ends_with("(taken 14:05)."));
    }

    #[test]
    fn small_heights_are_drawn_taller_by_a_round_factor() {
        assert_eq!(exaggeration(100.0, 30.0), 1.0, "a climb that shows is left alone");
        assert_eq!(exaggeration(2000.0, 60.0), 5.0);
        assert_eq!(exaggeration(2000.0, 1.0), 500.0);
        assert_eq!(exaggeration(1e9, 1.0), 1000.0, "bounded");
        assert_eq!(exaggeration(100.0, 0.0), 1.0);
        assert_eq!(exaggeration(f64::NAN, 1.0), 1.0);
    }

    #[test]
    fn grid_steps_are_round_numbers() {
        assert_eq!(nice_step(100.0), 20.0);
        assert_eq!(nice_step(37.0), 5.0);
        assert_eq!(nice_step(6.0), 1.0);
        assert_eq!(nice_step(900.0), 200.0);
        assert_eq!(nice_step(0.0), 1.0);
        assert_eq!(nice_step(f64::NAN), 1.0);
    }

    #[test]
    fn the_scene_is_turned_and_tilted_about_its_centre() {
        let mid = Pos2::new(100.0, 100.0);
        // from the south, level: east is to the right, up is up, north is depth
        assert_eq!(
            project([10.0, 0.0, 0.0], [0.0; 3], 2.0, 0.0, 0.0, mid),
            Pos2::new(120.0, 100.0)
        );
        assert_eq!(
            project([0.0, 0.0, 10.0], [0.0; 3], 2.0, 0.0, 0.0, mid),
            Pos2::new(100.0, 80.0)
        );
        assert_eq!(project([0.0, 10.0, 0.0], [0.0; 3], 2.0, 0.0, 0.0, mid), mid);
        // from straight above, north is up the screen
        let top = project([0.0, 10.0, 0.0], [0.0; 3], 2.0, 0.0, std::f32::consts::FRAC_PI_2, mid);
        assert!((top.x - 100.0).abs() < 1e-3 && (top.y - 80.0).abs() < 1e-3, "{top:?}");
        // the centre stays in the middle whatever the view
        assert_eq!(project([5.0, 6.0, 7.0], [5.0, 6.0, 7.0], 3.0, 1.0, 0.7, mid), mid);
    }

    #[test]
    fn a_flat_or_single_track_still_has_a_box() {
        let c = Compare {
            reference: vec![[0.0, 0.0, 5.0], [100.0, 0.0, 5.0]],
            flown: Vec::new(),
            deviation: None,
            amsl: false,
            color: Color32::WHITE,
            yaw: 0.0,
            pitch: 0.5,
            zoom: 1.0,
        };
        let (lo, hi) = bounds(&c);
        assert_eq!((lo[0], hi[0]), (0.0, 100.0));
        assert_eq!((lo[1], hi[1]), (-0.5, 0.5), "no extent north: a metre around it");
        assert_eq!((lo[2], hi[2]), (4.5, 5.5));
    }
}
