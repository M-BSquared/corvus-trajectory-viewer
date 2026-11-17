//! The rules of the Trajectory Viewer, free of the interface: reading a file,
//! turning its numbers into longitude and latitude, the flown track and how
//! far it lies from the trajectory. Each is the twin of a function of
//! `trajectory-viewer.js` and is held to what that one answered.

use serde_json::{json, Value};

/// A point of the file: x, y and the optional z.
pub type Point = (f64, f64, Option<f64>);
/// `[longitude, latitude]`.
pub type LngLat = [f64; 2];
/// `[east, north, up]` in metres.
pub type Enu = [f64; 3];

pub const MAX_POINTS: usize = 50_000;
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// What the numbers of a file mean: `(id, label)`.
pub const FRAMES: [(&str, &str); 4] = [
    ("wgs84", "WGS84 / EPSG:4326 (longitude, latitude)"),
    ("gps", "GPS (latitude, longitude)"),
    ("utm", "UTM / Projected metres (easting, northing)"),
    ("local", "Local frame (metres from the aircraft)"),
];

/// `(id, label, zone)`, all on the northern half.
pub const UTM_ZONES: [(&str, &str, u32); 5] = [
    ("31N", "Zone 31N (West Germany / Benelux / France)", 31),
    ("32N", "Zone 32N / EPSG:32632 / EPSG:25832 (Munich, Central Europe)", 32),
    ("33N", "Zone 33N / EPSG:32633 (Eastern Germany, Austria)", 33),
    ("34N", "Zone 34N (Poland, Eastern Europe)", 34),
    ("35N", "Zone 35N (Finland, Ukraine)", 35),
];

/// `(id, label, colour)`.
pub const COLORS: [(&str, &str, &str); 5] = [
    ("blue", "Blue", "#0000FF"),
    ("cyan", "Cyan", "#2BC4E4"),
    ("magenta", "Pink", "#E040FB"),
    ("green", "Green", "#00E676"),
    ("orange", "Orange", "#FF9100"),
];
pub const DEFAULT_COLOR: &str = "cyan";

pub const AXES: [(&str, &str); 2] = [
    ("frd", "y to the right (FRD, PX4)"),
    ("flu", "y to the left (FLU, ROS)"),
];

// WGS84 ellipsoid.
const WGS84_A: f64 = 6_378_137.0;
const WGS84_E2: f64 = 6.694_379_990_14e-3;

// ---- reading a file -------------------------------------------------------

/// The fields of one line (`splitFields`): semicolons, tabs, commas or blanks
/// separate them, and a semicolon or tab file may write decimals with a comma.
pub fn split_fields(line: &str) -> Vec<String> {
    let mut fields: Vec<String> = if line.contains(';') {
        line.split(';').map(|f| f.trim().replacen(',', ".", 1)).collect()
    } else if line.contains('\t') {
        line.split('\t').map(|f| f.trim().replacen(',', ".", 1)).collect()
    } else if line.contains(',') {
        line.split(',').map(|f| f.trim().to_string()).collect()
    } else {
        line.split_whitespace().map(str::to_string).collect()
    };
    while fields.last().is_some_and(String::is_empty) {
        fields.pop();
    }
    fields
}

/// `NUMBER_RE`: an optional sign, digits with an optional fraction (or a
/// fraction alone) and an optional exponent. Stricter than `f64::from_str`,
/// which also takes `inf` and `nan`.
fn is_number(text: &str) -> bool {
    let s = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((whole, frac)) => {
            (digits(whole) && (frac.is_empty() || digits(frac))) || (whole.is_empty() && digits(frac))
        }
        None => digits(mantissa),
    };
    mantissa_ok && exponent.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)))
}

/// What a file held.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Parsed {
    pub points: Vec<Point>,
    /// Points in the file, before thinning.
    pub total: usize,
    pub thinned: bool,
    /// Lines passed over, and the number of the first.
    pub skipped: usize,
    pub first_skipped: usize,
    pub has_z: bool,
    pub error: String,
}

/// Reads a trajectory (`parseTrajectory`): one point per line, two or three
/// numbers each. Empty lines, comments (`#`, `//`, `%`) and a header line are
/// passed over; a file longer than `MAX_POINTS` is thinned evenly, keeping its
/// last point.
pub fn parse_trajectory(text: &str) -> Parsed {
    let mut points: Vec<Point> = Vec::new();
    let (mut skipped, mut first_skipped, mut wrong_count) = (0usize, 0usize, 0usize);
    let mut seen_data = false;
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    for (i, raw) in unified.split('\n').enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") || line.starts_with('%') {
            continue;
        }
        let fields = split_fields(line);
        let numeric = !fields.is_empty() && fields.iter().all(|f| is_number(f));
        if numeric && (fields.len() == 2 || fields.len() == 3) {
            let n: Vec<f64> = fields.iter().filter_map(|f| f.parse().ok()).collect();
            if n.len() == fields.len() && n.iter().all(|v| v.is_finite()) {
                points.push((n[0], n[1], n.get(2).copied()));
                seen_data = true;
                continue;
            }
        }
        if !seen_data && !numeric && skipped == 0 && points.is_empty() {
            // the header line
            seen_data = true;
            continue;
        }
        if numeric {
            wrong_count += 1;
        }
        skipped += 1;
        if first_skipped == 0 {
            first_skipped = i + 1;
        }
    }

    let total = points.len();
    let mut thinned = false;
    if points.len() > MAX_POINTS {
        let step = points.len().div_ceil(MAX_POINTS);
        let last = points[points.len() - 1];
        let mut kept: Vec<Point> = points.iter().step_by(step).copied().collect();
        if !(points.len() - 1).is_multiple_of(step) {
            kept.push(last);
        }
        points = kept;
        thinned = true;
    }

    let error = match total {
        0 if wrong_count > 0 => "No line has two or three numbers. Each line needs x, y and optionally z.",
        0 => "No points found. Each line needs two or three numbers: x, y and optionally z.",
        1 => "Only one point found. A trajectory needs at least two.",
        _ => "",
    };
    let has_z = points.iter().any(|p| p.2.is_some());
    Parsed {
        points: if error.is_empty() { points } else { Vec::new() },
        total,
        thinned,
        skipped,
        first_skipped,
        has_z,
        error: error.to_string(),
    }
}

fn number_text(v: f64) -> String {
    corvus_api::data::units::js_number(v)
}

/// The points as the settings keep them: one per line, blanks between.
pub fn encode_points(points: &[Point]) -> String {
    points
        .iter()
        .map(|p| match p.2 {
            Some(z) => format!("{} {} {}", number_text(p.0), number_text(p.1), number_text(z)),
            None => format!("{} {}", number_text(p.0), number_text(p.1)),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn decode_points(text: &str) -> Vec<Point> {
    if text.is_empty() {
        Vec::new()
    } else {
        parse_trajectory(text).points
    }
}

// ---- from the file's frame to the map -------------------------------------

/// Where the local frame is fixed: the aircraft's position and heading when
/// the operator anchored it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    pub lat: f64,
    pub lon: f64,
    pub heading: f64,
    /// When it was taken, in milliseconds since 1970.
    pub at: f64,
}

/// A point of the aircraft's own frame on the globe (`localToLngLat`): x the
/// way the nose points, y to the right (`frd`) or to the left (`flu`).
pub fn local_to_lnglat(x: f64, y: f64, anchor: &Anchor, axes: &str) -> LngLat {
    let h = anchor.heading.to_radians();
    let right = if axes == "flu" { -y } else { y };
    let north = x * h.cos() - right * h.sin();
    let east = x * h.sin() + right * h.cos();
    let phi = anchor.lat.to_radians();
    let s = phi.sin();
    let w = (1.0 - WGS84_E2 * s * s).sqrt();
    let r_meridian = WGS84_A * (1.0 - WGS84_E2) / (w * w * w);
    let r_normal = WGS84_A / w;
    [
        anchor.lon + (east / (r_normal * phi.cos())).to_degrees(),
        anchor.lat + (north / r_meridian).to_degrees(),
    ]
}

/// UTM metres on the globe (`utmToLngLat`): the Krüger series to the third
/// order, good to well under a millimetre inside a zone.
pub fn utm_to_lnglat(easting: f64, northing: f64, zone: u32, south: bool) -> LngLat {
    let k0 = 0.9996;
    let f = 1.0 - (1.0 - WGS84_E2).sqrt();
    let n = f / (2.0 - f);
    let (n2, n3) = (n * n, n * n * n);
    let n4 = n3 * n;
    let a = (WGS84_A / (1.0 + n)) * (1.0 + n2 / 4.0 + n4 / 64.0);
    let beta = [
        n / 2.0 - (2.0 * n2) / 3.0 + (37.0 * n3) / 96.0,
        n2 / 48.0 + n3 / 15.0,
        (17.0 * n3) / 480.0,
    ];
    let delta = [
        2.0 * n - (2.0 * n2) / 3.0 - 2.0 * n3,
        (7.0 * n2) / 3.0 - (8.0 * n3) / 5.0,
        (56.0 * n3) / 15.0,
    ];
    let xi = (northing - if south { 1e7 } else { 0.0 }) / (k0 * a);
    let eta = (easting - 5e5) / (k0 * a);
    let (mut xi_p, mut eta_p) = (xi, eta);
    for (j, b) in beta.iter().enumerate() {
        let k = 2.0 * (j as f64 + 1.0);
        xi_p -= b * (k * xi).sin() * (k * eta).cosh();
        eta_p -= b * (k * xi).cos() * (k * eta).sinh();
    }
    let chi = (xi_p.sin() / eta_p.cosh()).asin();
    let mut phi = chi;
    for (j, d) in delta.iter().enumerate() {
        phi += d * (2.0 * (j as f64 + 1.0) * chi).sin();
    }
    let lam0 = (f64::from(zone) * 6.0 - 183.0).to_radians();
    let lam = lam0 + eta_p.sinh().atan2(xi_p.cos());
    [lam.to_degrees(), phi.to_degrees()]
}

fn fits_degrees(lng: f64, lat: f64) -> bool {
    lat.abs() <= 90.0 && lng.abs() <= 180.0
}

/// The points as longitude and latitude, or why they cannot be (`toLngLat`).
pub fn to_lnglat(
    points: &[Point],
    frame: &str,
    anchor: Option<&Anchor>,
    axes: &str,
    utm_zone: &str,
) -> Result<Vec<LngLat>, String> {
    if frame == "local" {
        let Some(anchor) = anchor.filter(|a| a.lat.is_finite() && a.lon.is_finite()) else {
            return Err("Anchor the frame at the aircraft first.".into());
        };
        return Ok(points.iter().map(|p| local_to_lnglat(p.0, p.1, anchor, axes)).collect());
    }
    if frame == "utm" {
        let zone = UTM_ZONES.iter().find(|z| z.0 == utm_zone).unwrap_or(&UTM_ZONES[1]).2;
        let out: Vec<LngLat> = points.iter().map(|p| utm_to_lnglat(p.0, p.1, zone, false)).collect();
        let plausible = points.iter().all(|p| (1e5..=9e5).contains(&p.0) && p.1.abs() <= 1e7);
        let on_globe = out
            .iter()
            .all(|c| c[0].is_finite() && c[1].is_finite() && fits_degrees(c[0], c[1]) && c[1].abs() <= 84.0);
        if plausible && on_globe {
            return Ok(out);
        }
        return Err("These numbers are not UTM metres. Easting is about 166000 to 834000 and northing is up to 10000000. Degrees go under WGS84 or GPS.".into());
    }
    let lat_first = frame == "gps";
    let coords: Vec<LngLat> = points
        .iter()
        .map(|p| if lat_first { [p.1, p.0] } else { [p.0, p.1] })
        .collect();
    if coords.iter().all(|c| fits_degrees(c[0], c[1])) {
        return Ok(coords);
    }
    let swapped = coords.iter().all(|c| fits_degrees(c[1], c[0]));
    let mut error = String::from("These numbers are not degrees of latitude and longitude.");
    if swapped {
        error = if lat_first {
            "These look like longitude first. Choose WGS84 / EPSG:4326.".into()
        } else {
            "These look like latitude first. Choose GPS.".into()
        };
    } else if points.iter().any(|p| p.0.abs() > 360.0 || p.1.abs() > 360.0) {
        let utm = points
            .iter()
            .all(|p| (1e5..=9e5).contains(&p.0) && p.1 > 0.0 && p.1 < 1e7);
        error.push_str(if utm {
            " These look like UTM metres. Choose UTM and select your zone."
        } else {
            " Metres from the aircraft go under Local frame."
        });
    }
    Err(error)
}

fn metres_between(a: LngLat, b: LngLat) -> f64 {
    let mid_lat = ((a[1] + b[1]) / 2.0).to_radians();
    let dx = (b[0] - a[0]).to_radians() * mid_lat.cos() * WGS84_A;
    let dy = (b[1] - a[1]).to_radians() * WGS84_A;
    dx.hypot(dy)
}

/// The length of the line over the ground, in metres.
pub fn path_length(coords: &[LngLat]) -> f64 {
    coords.windows(2).map(|w| metres_between(w[0], w[1])).sum()
}

/// A point's height, up positive: the FRD local frame writes z down.
pub fn height_of(z: f64, frame: &str, axes: &str) -> f64 {
    if frame == "local" && axes != "flu" {
        -z
    } else {
        z
    }
}

/// The lowest and highest height of the file, or None when it has none.
pub fn height_range(points: &[Point], frame: &str, axes: &str) -> Option<(f64, f64)> {
    points
        .iter()
        .filter_map(|p| p.2)
        .map(|z| height_of(z, frame, axes))
        .fold(None, |acc, up| match acc {
            None => Some((up, up)),
            Some((lo, hi)) => Some((lo.min(up), hi.max(up))),
        })
}

fn position_of(state: &Value) -> Option<LngLat> {
    if state.get("connected").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let p = state.get("position")?.as_array()?;
    let (lon, lat) = (p.first()?.as_f64()?, p.get(1)?.as_f64()?);
    (lon.is_finite() && lat.is_finite() && (lon != 0.0 || lat != 0.0)).then_some([lon, lat])
}

/// Where the aircraft is and the way it faces, as an anchor
/// (`anchorFromState`): None without a link or a position.
pub fn anchor_from_state(state: &Value, now_ms: f64) -> Option<Anchor> {
    let [lon, lat] = position_of(state)?;
    let heading = state.get("heading").and_then(Value::as_f64).filter(|h| h.is_finite());
    Some(Anchor {
        lat,
        lon,
        heading: heading.map_or(0.0, |h| h.rem_euclid(360.0)),
        at: now_ms,
    })
}

// ---- the flown track and the comparison -----------------------------------

/// Samples of the flown track kept; beyond this the oldest go.
pub const FLOWN_MAX: usize = 20_000;
const FLOWN_MIN_STEP_M: f64 = 1.0;

/// Adds the aircraft's position (`[lng, lat, altitude AMSL]`) to `buf` when it
/// is armed, has a fix and has moved a metre since the last sample
/// (`recordFlown`). True when a sample was added.
pub fn record_flown(buf: &mut Vec<Enu>, state: &Value) -> bool {
    if state.get("armed").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let Some([lon, lat]) = position_of(state) else {
        return false;
    };
    let alt = state
        .get("altitude_amsl")
        .and_then(Value::as_f64)
        .filter(|a| a.is_finite())
        .unwrap_or(0.0);
    if let Some(last) = buf.last() {
        if metres_between([last[0], last[1]], [lon, lat]) < FLOWN_MIN_STEP_M && (last[2] - alt).abs() < FLOWN_MIN_STEP_M
        {
            return false;
        }
    }
    buf.push([lon, lat, alt]);
    let over = buf.len().saturating_sub(FLOWN_MAX);
    buf.drain(..over);
    true
}

/// Both tracks as east, north, up metres around the reference's first point
/// (`buildComparison`). Heights are above each track's own start: a file does
/// not say what its z is measured from, so this is the one reading that
/// compares them without a guess. With `amsl` both keep their own heights
/// instead, for a file that is itself written in AMSL.
pub fn build_comparison(coords: &[LngLat], heights: &[f64], track: &[Enu], amsl: bool) -> (Vec<Enu>, Vec<Enu>) {
    let Some(first) = coords.first() else {
        return (Vec::new(), Vec::new());
    };
    let (lng0, lat0) = (first[0], first[1]);
    let k = std::f64::consts::PI / 180.0 * WGS84_A;
    let cos_phi = lat0.to_radians().cos();
    let enu = |lng: f64, lat: f64, up: f64| [(lng - lng0) * k * cos_phi, (lat - lat0) * k, up];
    let reference = coords
        .iter()
        .enumerate()
        .map(|(i, c)| {
            enu(
                c[0],
                c[1],
                heights.get(i).copied().filter(|h| h.is_finite()).unwrap_or(0.0),
            )
        })
        .collect();
    let base = if amsl { 0.0 } else { track.first().map_or(0.0, |t| t[2]) };
    let flown = track.iter().map(|c| enu(c[0], c[1], c[2] - base)).collect();
    (reference, flown)
}

fn dist_to_segment(p: Enu, a: Enu, b: Enu) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let t = if len2 > 0.0 {
        (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let d = [
        p[0] - a[0] - t * ab[0],
        p[1] - a[1] - t * ab[1],
        p[2] - a[2] - t * ab[2],
    ];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

/// How far the flown points lie from the reference line, in metres:
/// `(largest, mean)`, or None when either track is too short (`deviation`).
pub fn deviation(reference: &[Enu], track: &[Enu]) -> Option<(f64, f64)> {
    if reference.len() < 2 || track.is_empty() {
        return None;
    }
    let (mut max, mut sum) = (0.0f64, 0.0f64);
    for p in track {
        let d = reference
            .windows(2)
            .map(|w| dist_to_segment(*p, w[0], w[1]))
            .fold(f64::INFINITY, f64::min);
        max = max.max(d);
        sum += d;
    }
    Some((max, sum / track.len() as f64))
}

// ---- saved settings -------------------------------------------------------

/// What the plugin keeps between sessions.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub file: String,
    /// The points, as `encode_points` writes them.
    pub points: String,
    pub frame: String,
    pub utm_zone: String,
    pub axes: String,
    pub color: String,
    pub anchor: Option<Anchor>,
    /// Whether the line is on the Home map.
    pub drawn: bool,
    /// Whether the 3D comparison keeps absolute heights.
    pub amsl: bool,
}

impl Settings {
    /// The saved settings, cleaned (`normalizeSettings`): anything unknown is
    /// the default, and the frames of older versions are taken over.
    pub fn from_value(raw: &Value) -> Settings {
        let text = |k: &str| raw.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let anchor = raw.get("anchor").and_then(|a| {
            let n = |k: &str| a.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
            let (lat, lon) = (n("lat")?, n("lon")?);
            (lat.abs() <= 90.0 && lon.abs() <= 180.0).then(|| Anchor {
                lat,
                lon,
                heading: n("heading").unwrap_or(0.0),
                at: n("at").unwrap_or(0.0),
            })
        });
        let (mut frame, mut utm_zone) = (text("frame"), text("utmZone"));
        if utm_zone.is_empty() {
            utm_zone = "32N".into();
        }
        match frame.as_str() {
            "epsg32632" | "epsg25832" => {
                frame = "utm".into();
                utm_zone = "32N".into();
            }
            "epsg32633" => {
                frame = "utm".into();
                utm_zone = "33N".into();
            }
            _ => {}
        }
        let known = |list: &[&str], v: String, default: &str| {
            if list.contains(&v.as_str()) {
                v
            } else {
                default.to_string()
            }
        };
        Settings {
            file: text("file"),
            points: text("points"),
            frame: known(&FRAMES.map(|f| f.0), frame, "wgs84"),
            utm_zone: known(&UTM_ZONES.map(|z| z.0), utm_zone, "32N"),
            axes: known(&AXES.map(|a| a.0), text("axes"), "frd"),
            color: known(&COLORS.map(|c| c.0), text("color"), DEFAULT_COLOR),
            anchor,
            drawn: raw.get("drawn") == Some(&json!(true)),
            amsl: raw.get("amsl") == Some(&json!(true)),
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "file": self.file,
            "points": self.points,
            "frame": self.frame,
            "utmZone": self.utm_zone,
            "axes": self.axes,
            "color": self.color,
            "anchor": self.anchor.map(|a| json!({"lat": a.lat, "lon": a.lon, "heading": a.heading, "at": a.at})),
            "drawn": self.drawn,
            "amsl": self.amsl,
        })
    }

    /// The colour of the line, as `#RRGGBB`.
    pub fn color_hex(&self) -> &'static str {
        COLORS.iter().find(|c| c.0 == self.color).unwrap_or(&COLORS[0]).2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn a_line_is_split_at_what_separates_it() {
        assert_eq!(split_fields("11.5, 48.1, 520"), ["11.5", "48.1", "520"]);
        assert_eq!(split_fields("11,5; 48,1; 520"), ["11.5", "48.1", "520"]);
        assert_eq!(split_fields("11,5\t48,1"), ["11.5", "48.1"]);
        assert_eq!(split_fields("  11.5   48.1  "), ["11.5", "48.1"]);
        assert_eq!(
            split_fields("11.5,48.1,"),
            ["11.5", "48.1"],
            "a trailing separator adds no field"
        );
    }

    #[test]
    fn numbers_are_what_the_web_plugin_took_for_numbers() {
        for ok in ["1", "-1.5", "+.5", "5.", "1e5", "1.5E-3", "0"] {
            assert!(is_number(ok), "{ok}");
        }
        for bad in ["", "-", ".", "1e", "inf", "nan", "1.2.3", "0x10", "1 2", "e5", "--1"] {
            assert!(!is_number(bad), "{bad}");
        }
    }

    #[test]
    fn a_file_is_read_past_comments_a_header_and_bad_lines() {
        let p = parse_trajectory("# a route\nlon,lat,alt\n11.5,48.1,520\r\n\r\n11.6,48.2,530\n// done\n");
        assert_eq!(p.points, [(11.5, 48.1, Some(520.0)), (11.6, 48.2, Some(530.0))]);
        assert_eq!((p.total, p.skipped, p.has_z, p.error.as_str()), (2, 0, true, ""));

        let p = parse_trajectory("11.5 48.1\nbroken line\n1 2 3 4\n11.6 48.2\n");
        assert_eq!(p.points.len(), 2);
        assert_eq!((p.skipped, p.first_skipped, p.has_z), (2, 2, false));

        let p = parse_trajectory("x y\n1 2 3 4\n5\n");
        assert_eq!(
            p.error,
            "No line has two or three numbers. Each line needs x, y and optionally z."
        );
        assert_eq!(
            parse_trajectory("hello\nworld\n").error,
            "No points found. Each line needs two or three numbers: x, y and optionally z."
        );
        let one = parse_trajectory("11.5 48.1\n");
        assert_eq!(one.error, "Only one point found. A trajectory needs at least two.");
        assert!(one.points.is_empty());
        // Old Mac line ends, and a second header is a skipped line.
        let p = parse_trajectory("a,b\r1,2\rc,d\r3,4\r");
        assert_eq!((p.points.len(), p.skipped, p.first_skipped), (2, 1, 3));
    }

    #[test]
    fn a_long_file_is_thinned_evenly_and_keeps_its_end() {
        let n = MAX_POINTS * 2 + 1;
        let text: String = (0..n).map(|i| format!("{i} 0\n")).collect();
        let p = parse_trajectory(&text);
        assert!(p.thinned);
        assert_eq!(p.total, n);
        assert!(p.points.len() <= MAX_POINTS + 1);
        assert_eq!(p.points[0].0, 0.0);
        assert_eq!(p.points[1].0, 3.0, "one in every three");
        assert_eq!(p.points.last().unwrap().0, (n - 1) as f64, "the last point stays");
    }

    #[test]
    fn points_survive_being_saved() {
        let pts = vec![(11.5, 48.125, Some(-10.0)), (1e-7, 691_000.25, None)];
        let text = encode_points(&pts);
        assert_eq!(text, "11.5 48.125 -10\n0.0000001 691000.25");
        // A lone point is not a trajectory, so two are needed to come back.
        assert_eq!(decode_points(&text), pts);
        assert_eq!(decode_points(""), []);
    }

    #[test]
    fn utm_metres_land_where_the_survey_says() {
        // What the web plugin answered, to the last digits.
        let c = utm_to_lnglat(691_608.0, 5_334_764.0, 32, false);
        assert!(
            close(c[0], 11.575_559_498_004_777, 1e-12) && close(c[1], 48.137_254_415_952_83, 1e-12),
            "{c:?}"
        );
        let c = utm_to_lnglat(300_000.0, 6_000_000.0, 33, false);
        assert!(
            close(c[0], 11.940_406_316_616_539, 1e-12) && close(c[1], 54.109_206_441_304_096, 1e-12),
            "{c:?}"
        );
        // Independent of it: the meridian from the equator to 45 N is
        // 4984944.378 m on WGS84, times the scale of 0.9996 on the central meridian.
        let c = utm_to_lnglat(500_000.0, 4_982_950.4, 32, false);
        assert!(close(c[0], 9.0, 1e-9) && close(c[1], 45.0, 1e-7), "{c:?}");
        // The central meridian at the equator.
        let c = utm_to_lnglat(500_000.0, 0.0, 33, false);
        assert!(close(c[0], 15.0, 1e-9) && close(c[1], 0.0, 1e-9), "{c:?}");
        // The southern half counts its northing from ten million.
        let c = utm_to_lnglat(500_000.0, 1e7, 33, true);
        assert!(close(c[1], 0.0, 1e-9), "{c:?}");
    }

    #[test]
    fn the_local_frame_follows_the_nose() {
        let north = Anchor {
            lat: 48.0,
            lon: 11.0,
            heading: 0.0,
            at: 0.0,
        };
        let ahead = local_to_lnglat(100.0, 0.0, &north, "frd");
        assert!(close(ahead[0], 11.0, 1e-9) && ahead[1] > 48.0);
        assert!(close(metres_between([11.0, 48.0], ahead), 100.0, 0.5));
        let right = local_to_lnglat(0.0, 100.0, &north, "frd");
        assert!(
            right[0] > 11.0 && close(right[1], 48.0, 1e-9),
            "y to the right is east when facing north"
        );
        let left = local_to_lnglat(0.0, 100.0, &north, "flu");
        assert!(left[0] < 11.0, "y to the left is west");
        // What the web plugin answered for a frame turned 30 degrees.
        let turned = Anchor { heading: 30.0, ..north };
        let p = local_to_lnglat(100.0, 50.0, &turned, "frd");
        assert!(
            close(p[0], 11.001_250_262_353_68, 1e-12) && close(p[1], 48.000_554_027_895_05, 1e-12),
            "{p:?}"
        );
        let east = Anchor { heading: 90.0, ..north };
        let ahead = local_to_lnglat(100.0, 0.0, &east, "frd");
        assert!(ahead[0] > 11.0 && close(ahead[1], 48.0, 1e-9));
    }

    #[test]
    fn the_frame_is_checked_and_a_wrong_choice_is_named() {
        let deg = [(11.5, 48.1, None), (11.6, 48.2, None)];
        assert_eq!(to_lnglat(&deg, "wgs84", None, "frd", "32N").unwrap()[0], [11.5, 48.1]);
        assert_eq!(to_lnglat(&deg, "gps", None, "frd", "32N").unwrap()[0], [48.1, 11.5]);
        let lat_first = [(48.1, 111.5, None), (48.2, 111.6, None)];
        assert_eq!(
            to_lnglat(&lat_first, "wgs84", None, "frd", "32N").unwrap_err(),
            "These look like latitude first. Choose GPS."
        );
        let lon_first = [(111.5, 48.1, None), (111.6, 48.2, None)];
        assert_eq!(
            to_lnglat(&lon_first, "gps", None, "frd", "32N").unwrap_err(),
            "These look like longitude first. Choose WGS84 / EPSG:4326."
        );
        let utm = [(691_608.0, 5_334_764.0, None), (691_700.0, 5_334_800.0, None)];
        assert_eq!(
            to_lnglat(&utm, "wgs84", None, "frd", "32N").unwrap_err(),
            "These numbers are not degrees of latitude and longitude. These look like UTM metres. Choose UTM and select your zone."
        );
        assert!(to_lnglat(&utm, "utm", None, "frd", "32N").is_ok());
        assert!(
            to_lnglat(&utm, "utm", None, "frd", "nonsense").is_ok(),
            "an unknown zone is 32N"
        );
        assert!(to_lnglat(&deg, "utm", None, "frd", "32N")
            .unwrap_err()
            .starts_with("These numbers are not UTM metres."));
        let metres = [(0.0, 0.0, None), (500.0, 20.0, None)];
        assert_eq!(
            to_lnglat(&metres, "wgs84", None, "frd", "32N").unwrap_err(),
            "These numbers are not degrees of latitude and longitude. Metres from the aircraft go under Local frame."
        );
        assert_eq!(
            to_lnglat(&metres, "local", None, "frd", "32N").unwrap_err(),
            "Anchor the frame at the aircraft first."
        );
    }

    #[test]
    fn lengths_and_heights_are_read_off_the_points() {
        let coords = [[11.0, 48.0], [11.0, 48.001], [11.001, 48.001]];
        let length = path_length(&coords);
        assert!(close(length, 185.805_325_305_824_62, 1e-9), "{length}");
        let pts = [(0.0, 0.0, Some(-10.0)), (1.0, 0.0, Some(-25.0)), (2.0, 0.0, None)];
        assert_eq!(
            height_range(&pts, "local", "frd"),
            Some((10.0, 25.0)),
            "FRD writes z down"
        );
        assert_eq!(height_range(&pts, "local", "flu"), Some((-25.0, -10.0)));
        assert_eq!(height_range(&pts, "wgs84", "frd"), Some((-25.0, -10.0)));
        assert_eq!(height_range(&[(0.0, 0.0, None)], "wgs84", "frd"), None);
    }

    #[test]
    fn the_anchor_needs_a_link_and_a_position() {
        let s = json!({"connected": true, "position": [11.5, 48.1], "heading": -90.0});
        let a = anchor_from_state(&s, 5.0).unwrap();
        assert_eq!((a.lat, a.lon, a.heading, a.at), (48.1, 11.5, 270.0, 5.0));
        assert_eq!(
            anchor_from_state(&json!({"connected": false, "position": [11.5, 48.1]}), 0.0),
            None
        );
        assert_eq!(
            anchor_from_state(&json!({"connected": true, "position": [0.0, 0.0]}), 0.0),
            None
        );
        assert_eq!(anchor_from_state(&json!({"connected": true}), 0.0), None);
        let no_heading = anchor_from_state(&json!({"connected": true, "position": [11.5, 48.1]}), 0.0).unwrap();
        assert_eq!(no_heading.heading, 0.0);
    }

    #[test]
    fn the_flown_track_is_recorded_while_armed_and_moving() {
        let mut buf = Vec::new();
        let at = |lon: f64, alt: f64, armed: bool| json!({"connected": true, "armed": armed, "position": [lon, 48.0], "altitude_amsl": alt});
        assert!(!record_flown(&mut buf, &at(11.0, 500.0, false)), "not while disarmed");
        assert!(record_flown(&mut buf, &at(11.0, 500.0, true)));
        assert!(
            !record_flown(&mut buf, &at(11.000001, 500.2, true)),
            "it has not moved a metre"
        );
        assert!(
            record_flown(&mut buf, &at(11.000001, 501.5, true)),
            "a climb of a metre counts"
        );
        assert!(record_flown(&mut buf, &at(11.0001, 501.5, true)));
        assert_eq!(buf.len(), 3);
        let mut full = vec![[0.0, 0.0, 0.0]; FLOWN_MAX];
        assert!(record_flown(&mut full, &at(11.0, 500.0, true)));
        assert_eq!(full.len(), FLOWN_MAX, "the oldest sample went");
    }

    #[test]
    fn both_tracks_are_compared_in_metres_from_the_start() {
        let coords = [[11.0, 48.0], [11.0, 48.001]];
        let track = [[11.0, 48.0, 500.0], [11.0001, 48.0005, 510.0]];
        let (reference, flown) = build_comparison(&coords, &[0.0, 20.0], &track, false);
        assert_eq!(reference[0], [0.0, 0.0, 0.0]);
        assert!(close(reference[1][1], 111.3, 0.2) && reference[1][2] == 20.0);
        assert_eq!(flown[0][2], 0.0, "heights are above the track's own start");
        assert_eq!(flown[1][2], 10.0);
        let (_, amsl) = build_comparison(&coords, &[0.0, 20.0], &track, true);
        assert_eq!(amsl[1][2], 510.0, "AMSL keeps the altitude");
        assert_eq!(build_comparison(&[], &[], &track, false), (vec![], vec![]));
    }

    #[test]
    fn the_deviation_is_the_distance_to_the_nearest_piece_of_the_line() {
        let reference = [[0.0, 0.0, 0.0], [100.0, 0.0, 0.0]];
        let track = [[50.0, 3.0, 4.0], [150.0, 0.0, 0.0], [10.0, 0.0, 0.0]];
        let (max, mean) = deviation(&reference, &track).unwrap();
        assert_eq!(max, 50.0, "past the end, the end is the nearest point");
        assert!(close(mean, (5.0 + 50.0 + 0.0) / 3.0, 1e-9));
        assert_eq!(deviation(&reference[..1], &track), None);
        assert_eq!(deviation(&reference, &[]), None);
        assert_eq!(
            deviation(&[[0.0; 3], [0.0; 3]], &[[3.0, 4.0, 0.0]]),
            Some((5.0, 5.0)),
            "a line of no length"
        );
    }

    #[test]
    fn settings_are_cleaned_and_old_frames_are_taken_over() {
        let s = Settings::from_value(&json!({}));
        assert_eq!(
            (
                s.frame.as_str(),
                s.utm_zone.as_str(),
                s.axes.as_str(),
                s.color.as_str(),
                s.drawn,
                s.amsl
            ),
            ("wgs84", "32N", "frd", "cyan", false, false)
        );
        let s = Settings::from_value(
            &json!({"frame": "epsg32633", "color": "plaid", "drawn": true, "axes": "flu",
            "anchor": {"lat": 48.1, "lon": 11.5, "heading": 90, "at": 7}}),
        );
        assert_eq!(
            (s.frame.as_str(), s.utm_zone.as_str(), s.color.as_str()),
            ("utm", "33N", "cyan")
        );
        assert!(s.drawn && s.axes == "flu");
        assert_eq!(s.anchor.map(|a| (a.lat, a.heading)), Some((48.1, 90.0)));
        assert_eq!(
            Settings::from_value(&json!({"anchor": {"lat": 148.1, "lon": 11.5}})).anchor,
            None
        );
        assert_eq!(Settings::from_value(&json!({"frame": "epsg25832"})).frame, "utm");
        // What is written is read back the same.
        assert_eq!(Settings::from_value(&s.to_value()), s);
        assert_eq!(s.color_hex(), "#2BC4E4");
    }
}
