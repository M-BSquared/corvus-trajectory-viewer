"use strict";
window.Corvus = window.Corvus || {};

/**
 * Trajectory Viewer: a trajectory from a file, drawn on the Home map.
 *
 * The file is plain text with one point per line, two or three numbers each:
 * x, y and optionally z. Commas, semicolons, tabs or spaces separate them; a
 * semicolon or tab file may write decimals with a comma. Empty lines, lines
 * starting with # // or %, and a header line are passed over. What the numbers
 * mean is the operator's choice, because a file does not say:
 *
 *   wgs84  WGS84 / EPSG:4326 in the order GIS tools write it: x is
 *          longitude, y is latitude, both in degrees (GeoJSON, QGIS).
 *   gps    The order a GPS receiver or a phone shows: latitude first, then
 *          longitude, in degrees.
 *   utm    Projected metres (easting, northing) in a selectable UTM zone
 *          (e.g. 32N / EPSG:32632 / EPSG:25832 or 33N / EPSG:32633).
 *   local  Metres in a frame of the aircraft's own: it is 0, 0, 0, x points
 *          the way its nose points, y to its right (FRD, as PX4 has it, z
 *          down) or to its left (FLU, as ROS has it, z up). The frame is taken
 *          from the aircraft's position and heading when the operator anchors
 *          it, and stays there.
 */
Corvus.pluginTrajectory = (function () {
  const LINE_KEY = "trajectory";

  const MAX_POINTS = 50000;
  const MAX_FILE_BYTES = 20 * 1024 * 1024;

  const FRAMES = [
    { id: "wgs84", label: "WGS84 / EPSG:4326 (longitude, latitude)" },
    { id: "gps", label: "GPS (latitude, longitude)" },
    { id: "utm", label: "UTM / Projected metres (easting, northing)" },
    { id: "local", label: "Local frame (metres from the aircraft)" },
  ];

  const UTM_ZONES = [
    { id: "31N", label: "Zone 31N (West Germany / Benelux / France)", zone: 31, south: false },
    { id: "32N", label: "Zone 32N / EPSG:32632 / EPSG:25832 (Munich, Central Europe)", zone: 32, south: false },
    { id: "33N", label: "Zone 33N / EPSG:32633 (Eastern Germany, Austria)", zone: 33, south: false },
    { id: "34N", label: "Zone 34N (Poland, Eastern Europe)", zone: 34, south: false },
    { id: "35N", label: "Zone 35N (Finland, Ukraine)", zone: 35, south: false },
  ];

  const COLORS = [
    { id: "blue", label: "Blue", color: "#0000FF" },
    { id: "cyan", label: "Cyan", color: "#2BC4E4" },
    { id: "magenta", label: "Pink", color: "#E040FB" },
    { id: "green", label: "Green", color: "#00E676" },
    { id: "orange", label: "Orange", color: "#FF9100" },
  ];

  const DEFAULT_COLOR = "cyan";

  const AXES = [
    { id: "frd", label: "y to the right (FRD, PX4)" },
    { id: "flu", label: "y to the left (FLU, ROS)" },
  ];

  // WGS84 ellipsoid.
  const WGS84_A = 6378137;
  const WGS84_E2 = 6.69437999014e-3;

  const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const COMMENT_RE = /^(#|\/\/|%)/;

  // ---- reading a file ---------------------------------------------------

  function splitFields(line) {
    let fields;
    if (line.indexOf(";") !== -1) {
      fields = line.split(";").map((f) => f.trim().replace(",", "."));
    } else if (line.indexOf("\t") !== -1) {
      fields = line.split("\t").map((f) => f.trim().replace(",", "."));
    } else if (line.indexOf(",") !== -1) {
      fields = line.split(",").map((f) => f.trim());
    } else {
      fields = line.trim().split(/\s+/);
    }
    while (fields.length && fields[fields.length - 1] === "") fields.pop();
    return fields;
  }

  function parseTrajectory(text) {
    const lines = String(text == null ? "" : text).split(/\r\n|\r|\n/);
    let points = [];
    let skipped = 0;
    let firstSkipped = 0;
    let wrongCount = 0;
    let seenData = false;
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || COMMENT_RE.test(line)) return;
      const fields = splitFields(line);
      const numeric = fields.length > 0 && fields.every((f) => NUMBER_RE.test(f));
      if (numeric && (fields.length === 2 || fields.length === 3)) {
        const x = Number(fields[0]);
        const y = Number(fields[1]);
        const z = fields.length === 3 ? Number(fields[2]) : null;
        if (isFinite(x) && isFinite(y) && (z === null || isFinite(z))) {
          points.push([x, y, z]);
          seenData = true;
          return;
        }
      }
      if (!seenData && !numeric && skipped === 0 && points.length === 0) {
        seenData = true;
        return;
      }
      if (numeric) wrongCount++;
      skipped++;
      if (!firstSkipped) firstSkipped = i + 1;
    });

    const total = points.length;
    let thinned = false;
    if (points.length > MAX_POINTS) {
      const step = Math.ceil(points.length / MAX_POINTS);
      const kept = [];
      for (let i = 0; i < points.length; i += step) kept.push(points[i]);
      if (kept[kept.length - 1] !== points[points.length - 1]) kept.push(points[points.length - 1]);
      points = kept;
      thinned = true;
    }

    let error = "";
    if (total === 0) {
      error = wrongCount
        ? "No line has two or three numbers. Each line needs x, y and optionally z."
        : "No points found. Each line needs two or three numbers: x, y and optionally z.";
    } else if (total === 1) {
      error = "Only one point found. A trajectory needs at least two.";
    }
    return {
      points: error ? [] : points,
      total,
      thinned,
      skipped,
      firstSkipped,
      hasZ: points.some((p) => p[2] !== null),
      error,
    };
  }

  function encodePoints(points) {
    return (points || []).map((p) => (p[2] === null || p[2] === undefined
      ? `${p[0]} ${p[1]}` : `${p[0]} ${p[1]} ${p[2]}`)).join("\n");
  }

  function decodePoints(text) {
    if (typeof text !== "string" || !text) return [];
    return parseTrajectory(text).points;
  }

  // ---- from the file's frame to the map ---------------------------------

  function localToLngLat(x, y, anchor, axes) {
    const h = (Number(anchor.heading) || 0) * Math.PI / 180;
    const right = axes === "flu" ? -y : y;
    const north = x * Math.cos(h) - right * Math.sin(h);
    const east = x * Math.sin(h) + right * Math.cos(h);
    const phi = anchor.lat * Math.PI / 180;
    const s = Math.sin(phi);
    const w = Math.sqrt(1 - WGS84_E2 * s * s);
    const rMeridian = WGS84_A * (1 - WGS84_E2) / (w * w * w);
    const rNormal = WGS84_A / w;
    return [
      anchor.lon + (east / (rNormal * Math.cos(phi))) * 180 / Math.PI,
      anchor.lat + (north / rMeridian) * 180 / Math.PI,
    ];
  }

  function utmToLngLat(easting, northing, zone, south) {
    const k0 = 0.9996;
    const f = 1 - Math.sqrt(1 - WGS84_E2);
    const n = f / (2 - f);
    const n2 = n * n, n3 = n2 * n, n4 = n3 * n;
    const A = (WGS84_A / (1 + n)) * (1 + n2 / 4 + n4 / 64);
    const beta = [
      n / 2 - (2 * n2) / 3 + (37 * n3) / 96,
      n2 / 48 + n3 / 15,
      (17 * n3) / 480,
    ];
    const delta = [
      2 * n - (2 * n2) / 3 - 2 * n3,
      (7 * n2) / 3 - (8 * n3) / 5,
      (56 * n3) / 15,
    ];
    const xi = (northing - (south ? 1e7 : 0)) / (k0 * A);
    const eta = (easting - 5e5) / (k0 * A);
    let xiP = xi, etaP = eta;
    for (let j = 1; j <= 3; j++) {
      xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
    let phi = chi;
    for (let j = 1; j <= 3; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
    const lam0 = (zone * 6 - 183) * Math.PI / 180;
    const lam = lam0 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
    return [lam * 180 / Math.PI, phi * 180 / Math.PI];
  }

  function p0InZoneRange(c) {
    return Math.abs(c[1]) <= 84;
  }

  function fitsDegrees(lng, lat) {
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function toLngLat(points, frame, anchor, axes, utmZone) {
    const pts = points || [];
    if (frame === "local") {
      if (!anchor || !isFinite(anchor.lat) || !isFinite(anchor.lon)) {
        return { coords: [], error: "Anchor the frame at the aircraft first." };
      }
      return { coords: pts.map((p) => localToLngLat(p[0], p[1], anchor, axes)), error: "" };
    }
    if (frame === "utm") {
      const zoneConfig = UTM_ZONES.find((z) => z.id === utmZone) || UTM_ZONES[1];
      const out = pts.map((p) => utmToLngLat(p[0], p[1], zoneConfig.zone, zoneConfig.south));
      const plausible = pts.every((p) => p[0] >= 1e5 && p[0] <= 9e5 && Math.abs(p[1]) <= 1e7);
      if (plausible && out.every((c) => isFinite(c[0]) && isFinite(c[1]) && fitsDegrees(c[0], c[1]) && p0InZoneRange(c))) {
        return { coords: out, error: "" };
      }
      return {
        coords: [],
        error: "These numbers are not UTM metres. Easting is about 166000 to 834000 " +
          "and northing is up to 10000000. Degrees go under WGS84 or GPS.",
      };
    }
    const latFirst = frame === "gps";
    const coords = pts.map((p) => (latFirst ? [p[1], p[0]] : [p[0], p[1]]));
    if (coords.every((c) => fitsDegrees(c[0], c[1]))) return { coords, error: "" };
    const swapped = coords.every((c) => fitsDegrees(c[1], c[0]));
    let error = "These numbers are not degrees of latitude and longitude.";
    if (swapped) {
      error = latFirst
        ? "These look like longitude first. Choose WGS84 / EPSG:4326."
        : "These look like latitude first. Choose GPS.";
    } else if (pts.some((p) => Math.abs(p[0]) > 360 || Math.abs(p[1]) > 360)) {
      error += pts.every((p) => p[0] >= 1e5 && p[0] <= 9e5 && p[1] > 0 && p[1] < 1e7)
        ? " These look like UTM metres. Choose UTM and select your zone."
        : " Metres from the aircraft go under Local frame.";
    }
    return { coords: [], error };
  }

  function pathLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1];
      const b = coords[i];
      const midLat = ((a[1] + b[1]) / 2) * Math.PI / 180;
      const dx = (b[0] - a[0]) * Math.PI / 180 * Math.cos(midLat) * WGS84_A;
      const dy = (b[1] - a[1]) * Math.PI / 180 * WGS84_A;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  }

  function heightRange(points, frame, axes) {
    let lo = Infinity;
    let hi = -Infinity;
    (points || []).forEach((p) => {
      if (p[2] === null || p[2] === undefined) return;
      const up = frame === "local" && axes !== "flu" ? -p[2] : p[2];
      lo = Math.min(lo, up);
      hi = Math.max(hi, up);
    });
    return lo === Infinity ? null : { lo, hi };
  }

  function anchorFromState(state, now) {
    const s = state || {};
    if (!s.connected || !Array.isArray(s.position)) return null;
    const lon = Number(s.position[0]);
    const lat = Number(s.position[1]);
    if (!isFinite(lon) || !isFinite(lat) || (lon === 0 && lat === 0)) return null;
    const heading = Number(s.heading);
    return {
      lat, lon,
      heading: isFinite(heading) ? ((heading % 360) + 360) % 360 : 0,
      at: typeof now === "number" ? now : Date.now(),
    };
  }

  // ---- the flown track and the comparison -------------------------------

  // Samples [lng, lat, altitude AMSL] of the aircraft while it is armed, kept
  // in memory for this session (the map's own track has no heights).
  const FLOWN_MAX = 20000;
  const FLOWN_MIN_STEP_M = 1;
  const flown = [];
  let recording = false;

  function metresBetween(a, b) {
    const midLat = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const dx = (b[0] - a[0]) * Math.PI / 180 * Math.cos(midLat) * WGS84_A;
    const dy = (b[1] - a[1]) * Math.PI / 180 * WGS84_A;
    return Math.hypot(dx, dy);
  }

  /**
   * Add the aircraft's position to `buf` when it is armed, has a fix and has
   * moved a metre since the last sample. True when a sample was added.
   *
   * Pure apart from `buf`, and exported for the test suite.
   */
  function recordFlown(buf, state) {
    const s = state || {};
    if (!s.connected || !s.armed || !Array.isArray(s.position)) return false;
    const lon = Number(s.position[0]);
    const lat = Number(s.position[1]);
    if (!isFinite(lon) || !isFinite(lat) || (lon === 0 && lat === 0)) return false;
    const alt = Number(s.altitude_amsl);
    const sample = [lon, lat, isFinite(alt) ? alt : 0];
    const last = buf[buf.length - 1];
    if (last && metresBetween(last, sample) < FLOWN_MIN_STEP_M && Math.abs(last[2] - sample[2]) < FLOWN_MIN_STEP_M) {
      return false;
    }
    buf.push(sample);
    if (buf.length > FLOWN_MAX) buf.splice(0, buf.length - FLOWN_MAX);
    return true;
  }

  function startRecording(api) {
    if (recording || !api || typeof api.subscribe !== "function") return;
    recording = true;
    api.subscribe((state) => { recordFlown(flown, state); });
  }

  /**
   * Both tracks as east/north/up metres around the reference's first point.
   * Heights are above each track's own start: the reference's z as the file
   * has it (negated for the FRD local frame), the flown track's altitude minus
   * its first sample's. A file does not say what its z is measured from, so
   * this is the one reading that compares them without a guess.
   *
   * Pure, and exported for the test suite.
   *
   * @param {Array} coords reference [[lng, lat], ...]
   * @param {Array} heights reference height per point, or null
   * @param {Array} track flown [[lng, lat, alt], ...]
   * @returns {{ref: Array, flown: Array}} [[east, north, up], ...] each
   */
  function buildComparison(coords, heights, track) {
    if (!coords.length) return { ref: [], flown: [] };
    const lng0 = coords[0][0];
    const lat0 = coords[0][1];
    const k = Math.PI / 180 * WGS84_A;
    const cosPhi = Math.cos(lat0 * Math.PI / 180);
    const enu = (c, up) => [(c[0] - lng0) * k * cosPhi, (c[1] - lat0) * k, up];
    const ref = coords.map((c, i) => enu(c, heights && isFinite(heights[i]) ? heights[i] : 0));
    const base = track.length ? track[0][2] : 0;
    return { ref, flown: track.map((c) => enu(c, c[2] - base)) };
  }

  function distToSegment(p, a, b) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let t = len2 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1], p[2] - a[2] - t * ab[2]);
  }

  /**
   * How far the flown points lie from the reference line, in metres:
   * {max, mean}, or null when either track is too short.
   *
   * Pure, and exported for the test suite.
   */
  function deviation(ref, track) {
    if (ref.length < 2 || !track.length) return null;
    let max = 0;
    let sum = 0;
    track.forEach((p) => {
      let d = Infinity;
      for (let i = 1; i < ref.length; i++) d = Math.min(d, distToSegment(p, ref[i - 1], ref[i]));
      max = Math.max(max, d);
      sum += d;
    });
    return { max, mean: sum / track.length };
  }

  // ---- saved settings ---------------------------------------------------

  function normalizeSettings(raw, colors) {
    const r = raw && typeof raw === "object" ? raw : {};
    const palette = COLORS;
    const a = r.anchor;
    const anchor = a && typeof a === "object" && isFinite(a.lat) && isFinite(a.lon)
      && Math.abs(a.lat) <= 90 && Math.abs(a.lon) <= 180
      ? { lat: Number(a.lat), lon: Number(a.lon), heading: Number(a.heading) || 0, at: Number(a.at) || 0 }
      : null;

    let frame = r.frame;
    let utmZone = r.utmZone || "32N";
    if (frame === "epsg32632" || frame === "epsg25832") {
      frame = "utm";
      utmZone = "32N";
    } else if (frame === "epsg32633") {
      frame = "utm";
      utmZone = "33N";
    }

    return {
      file: typeof r.file === "string" ? r.file : "",
      points: typeof r.points === "string" ? r.points : "",
      frame: FRAMES.some((f) => f.id === frame) ? frame : "wgs84",
      utmZone: UTM_ZONES.some((z) => z.id === utmZone) ? utmZone : "32N",
      axes: AXES.some((x) => x.id === r.axes) ? r.axes : "frd",
      color: palette.some((c) => c.id === r.color) ? r.color : DEFAULT_COLOR,
      anchor,
      drawn: r.drawn === true,
    };
  }

  function colorOf(api, id) {
    const hit = COLORS.find((c) => c.id === id) || COLORS[0];
    return hit.color;
  }

  function drawSaved(api, settings, points) {
    const pts = points || decodePoints(settings.points);
    if (pts.length < 2) return "There is no trajectory to draw. Choose a file first.";
    const res = toLngLat(pts, settings.frame, settings.anchor, settings.axes, settings.utmZone);
    if (res.error) return res.error;
    const ok = api.map.drawLine(LINE_KEY, res.coords, { color: colorOf(api, settings.color), width: 4 });
    return ok ? "" : "The map did not take the line.";
  }

  function start(api) {
    if (!api || !api.map || typeof api.getSettings !== "function") return;
    startRecording(api);
    const settings = normalizeSettings(api.getSettings(), api.map.colors);
    if (settings.drawn) drawSaved(api, settings);
  }

  // ---- the view ---------------------------------------------------------

  function formatDistance(m) {
    const units = window.Corvus && Corvus.units;
    return units && typeof units.formatDistance === "function"
      ? units.formatDistance(m) : `${Math.round(m)} m`;
  }

  function formatLength(m) {
    const units = window.Corvus && Corvus.units;
    return units && typeof units.formatLength === "function"
      ? units.formatLength(m) : `${Math.round(m)} m`;
  }

  function formatAnchor(anchor) {
    if (!anchor) return "Not anchored yet.";
    const when = anchor.at ? new Date(anchor.at) : null;
    const time = when && !isNaN(when.getTime())
      ? ` (taken ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")})`
      : "";
    return `Anchored at ${anchor.lat.toFixed(6)}, ${anchor.lon.toFixed(6)}, ` +
      `heading ${Math.round(anchor.heading)}°${time}.`;
  }

  function readFileText(file) {
    if (typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.readAsText(file);
    });
  }

  function init(containerEl, api) {
    const ui = Corvus.ui;
    containerEl.innerHTML = "";
    let cancelled = false;
    let settings = normalizeSettings(
      typeof api.getSettings === "function" ? api.getSettings() : {}, api.map.colors);
    let points = decodePoints(settings.points);
    let fix = null;

    // ---- file (stays on top: everything below works on it) ----
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt,.csv,.tsv,.xyz,.dat,.log,text/plain,text/csv";
    fileInput.className = "tv-file-input";
    fileInput.setAttribute("aria-hidden", "true");
    fileInput.tabIndex = -1;
    const chooseBtn = ui.button({
      variant: "secondary", icon: "folder-open", label: "Choose file\u2026",
      onClick: () => fileInput.click(),
    });
    const fileName = document.createElement("span");
    fileName.className = "tv-file-name";
    const fileRow = document.createElement("div");
    fileRow.className = "tv-file-row";
    fileRow.appendChild(chooseBtn);
    fileRow.appendChild(fileName);
    fileRow.appendChild(fileInput);
    const summary = ui.message({ className: "tv-summary" });
    const fileField = ui.field({
      label: "File",
      control: fileRow,
      info: "One point per line: x, y and optionally z, separated by commas, " +
            "semicolons, tabs or spaces. A file with semicolons or tabs may " +
            "write decimals with a comma.\n" +
            "Empty lines, a header line such as lon,lat,alt, and lines " +
            "starting with #, // or % are passed over.",
    });
    const fileBlock = document.createElement("div");
    fileBlock.className = "tv-file";
    fileBlock.appendChild(fileField);
    fileBlock.appendChild(summary.el);

    // ---- coordinates, colour and the map ----
    const frameSelect = ui.select({
      id: "tvFrame",
      ariaLabel: "Coordinates",
      value: settings.frame,
      options: FRAMES.map((f) => ({ value: f.id, label: f.label })),
      onChange: (next) => { update({ frame: next }); },
    });

    // UTM Zone choice
    const utmZoneSelect = ui.select({
      id: "tvUtmZone",
      ariaLabel: "UTM Zone",
      value: settings.utmZone,
      options: UTM_ZONES.map((z) => ({ value: z.id, label: z.label })),
      onChange: (next) => { update({ utmZone: next }); },
    });
    const utmBox = document.createElement("div");
    utmBox.className = "tv-sub-section tv-utm";
    utmBox.appendChild(ui.field({
      label: "Zone",
      control: utmZoneSelect,
      info: "UTM zone covering your survey area.\nZone 32N covers Munich and Western Germany; Zone 33N covers Eastern Germany.",
    }));

    // Local frame choice
    const axesSelect = ui.select({
      id: "tvAxes",
      ariaLabel: "Axes of the local frame",
      value: settings.axes,
      options: AXES.map((x) => ({ value: x.id, label: x.label })),
      onChange: (next) => { update({ axes: next }); },
    });
    const anchorText = document.createElement("div");
    anchorText.className = "tv-anchor";
    const anchorBtn = ui.button({
      variant: "secondary", icon: "locate-fixed", label: "Anchor at the aircraft",
      onClick: () => {
        if (!fix) return;
        update({ anchor: fix }, true);
      },
    });
    const localBox = document.createElement("div");
    localBox.className = "tv-sub-section tv-local";
    localBox.appendChild(ui.field({
      label: "Axes",
      control: axesSelect,
      info: "The aircraft is 0, 0, 0 and x points the way its nose points.\n" +
            "y to the right is FRD, as PX4 has it: z points down, so a height " +
            "of 10 m is z = -10. y to the left is FLU, as ROS has it: z points up.\n" +
            "The frame is fixed where the aircraft is and the way it faces when " +
            "you anchor it (or turn the line on without an anchor), and stays " +
            "there while it flies. Anchor again to move it to the aircraft.",
    }));
    localBox.appendChild(anchorText);
    localBox.appendChild(anchorBtn);

    const swatches = document.createElement("div");
    swatches.className = "tv-swatches";
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-label", "Line colour");
    const swatchEls = COLORS.map((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tv-swatch";
      b.dataset.color = c.id;
      b.title = c.label;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", c.label);
      b.style.setProperty("--tv-swatch", c.color);
      b.addEventListener("click", () => update({ color: c.id }));
      swatches.appendChild(b);
      return b;
    });
    const onMap = ui.toggle({
      id: "tvOnMap",
      value: settings.drawn,
      ariaLabel: "Show on the Home map",
      onChange: (next) => {
        if (!next) {
          api.map.remove(LINE_KEY);
          save({ drawn: false });
          status.hide();
          paint();
          return undefined;
        }
        let anchor = settings.anchor;
        if (settings.frame === "local" && !anchor && fix) anchor = fix;
        const why = drawSaved(api, Object.assign({}, settings, { anchor }), points);
        if (why) {
          status.show(settings.frame === "local" && !anchor
            ? "No aircraft position yet. Connect and wait for a GPS fix, then anchor the frame."
            : why, "err");
          return Promise.reject(new Error(why));
        }
        status.hide();
        save({ drawn: true, anchor });
        paint();
        return undefined;
      },
    });
    const fitBtn = ui.button({
      variant: "secondary", icon: "scan", label: "Show me",
      title: "Frame the trajectory on the Home map",
      onClick: () => {
        const res = toLngLat(points, settings.frame, settings.anchor, settings.axes, settings.utmZone);
        if (res.error) { status.show(res.error, "err"); return; }
        api.map.fit(res.coords);
      },
    });
    const clearBtn = ui.button({
      variant: "secondary", icon: "trash-2", label: "Clear",
      title: "Take the line off the map and forget the file",
      onClick: () => {
        api.map.remove(LINE_KEY);
        points = [];
        save({ file: "", points: "", drawn: false, anchor: null });
        status.hide();
        summary.hide();
        paint();
      },
    });
    const status = ui.message({ className: "tv-status" });

    function showComparison() {
      const res = toLngLat(points, settings.frame, settings.anchor, settings.axes, settings.utmZone);
      if (res.error) { status.show(res.error, "err"); return; }
      if (res.coords.length < 2) { status.show("There is no trajectory to compare. Choose a file first.", "warn"); return; }
      if (flown.length < 2) {
        status.show("There is no flown track yet. It is recorded while the aircraft is armed.", "warn");
        return;
      }
      const heights = points.map((p) => (p[2] === null || p[2] === undefined ? 0
        : (settings.frame === "local" && settings.axes !== "flu" ? -p[2] : p[2])));
      const cmp = buildComparison(res.coords, heights, flown);
      const dev = deviation(cmp.ref, cmp.flown);
      const host = document.createElement("div");
      host.className = "tv-plot";
      const info = document.createElement("p");
      info.className = "tv-plot-info";
      info.textContent = dev
        ? `Largest distance from the trajectory ${formatLength(dev.max)}, on average ${formatLength(dev.mean)}. ` +
          "Heights are above each track's start."
        : "";
      const body = document.createElement("div");
      body.appendChild(host);
      body.appendChild(info);
      const clearFlown = ui.button({
        variant: "secondary", icon: "trash-2", label: "Clear flown track",
        onClick: () => { flown.length = 0; dlg.close(); },
      });
      const dlg = ui.modal({
        title: "Trajectory and flown track",
        body, size: "lg", actions: clearFlown,
        onClose: () => {
          if (window.Plotly && host.isConnected !== false) { try { window.Plotly.purge(host); } catch (e) { /* gone */ } }
        },
      });
      dlg.open();
      const lazy = Corvus.lazy;
      const ready = window.Plotly ? Promise.resolve(window.Plotly)
        : (lazy && typeof lazy.plotly === "function" ? lazy.plotly() : Promise.reject(new Error("Plotly is not available.")));
      ready.then((Plotly) => {
        const theme = ui.plotlyTheme ? ui.plotlyTheme() : {};
        const axis = (title) => Object.assign({}, theme.xaxis || {}, { title });
        const trace = (name, pts, color, dash) => ({
          type: "scatter3d", mode: "lines", name,
          x: pts.map((p) => p[0]), y: pts.map((p) => p[1]), z: pts.map((p) => p[2]),
          line: { color, width: 5, dash },
        });
        const layout = {
          paper_bgcolor: theme.paper_bgcolor, plot_bgcolor: theme.plot_bgcolor, font: theme.font,
          margin: { l: 0, r: 0, t: 0, b: 0 },
          legend: { orientation: "h" },
          scene: {
            aspectmode: "data",
            xaxis: axis("East (m)"), yaxis: axis("North (m)"), zaxis: axis("Height (m)"),
          },
        };
        Plotly.newPlot(host, [
          trace("Trajectory", cmp.ref, colorOf(api, settings.color), "solid"),
          trace("Flown", cmp.flown, "#FF3B30", "solid"),
        ], layout, { displayModeBar: false, responsive: true });
      }).catch((err) => {
        host.textContent = (err && err.message) || "The plot could not be drawn.";
      });
    }
    const compareBtn = ui.button({
      variant: "secondary", icon: "box", label: "Compare in 3D",
      title: "Plot the trajectory and the flown track in 3D",
      onClick: showComparison,
    });

    // One card: the file on top, since everything below works on it.
    const lineCard = ui.card({});
    lineCard.classList.add("tv-card");
    lineCard.appendChild(fileBlock);
    lineCard.appendChild(ui.field({
      label: "Coordinates",
      control: frameSelect,
      info: "What the numbers in the file mean. A file does not say, so you choose.\n" +
            "WGS84 / EPSG:4326: degrees, x is longitude and y is latitude, the " +
            "order GIS tools write (GeoJSON, QGIS).\n" +
            "UTM: metres, x is easting and y is northing with selectable zone (zone 32N covers Munich).\n" +
            "GPS: degrees, latitude first, then longitude, the order a GPS " +
            "receiver or a phone shows.\n" +
            "Local frame: metres from the aircraft, along the way it faces.",
    }));
    lineCard.appendChild(utmBox);
    lineCard.appendChild(localBox);
    lineCard.appendChild(ui.field({ label: "Colour", control: swatches }));
    lineCard.appendChild(ui.field({
      label: "Show on the Home map",
      control: onMap.el,
      className: "field-switch",
      info: "Drawn under the flown track, so the aircraft's own path stays on " +
            "top where the two cross.\n" +
            "The line stays on the map when you close this plugin, and comes " +
            "back after a restart, until you switch it off.",
    }));
    const actions = document.createElement("div");
    actions.className = "tv-actions";
    actions.appendChild(fitBtn);
    actions.appendChild(compareBtn);
    actions.appendChild(clearBtn);
    lineCard.appendChild(actions);
    lineCard.appendChild(status.el);

    containerEl.appendChild(lineCard);

    // ---- behaviour ----

    function save(patch) {
      settings = Object.assign({}, settings, patch);
      if (typeof api.saveSettings !== "function") return;
      api.saveSettings(settings, true).catch((err) => {
        if (cancelled) return;
        status.show((err && err.message) || "Could not save the settings.", "err");
      });
    }

    function update(patch, isAnchor) {
      if (Object.keys(patch).length) save(patch);
      if (settings.drawn && settings.frame === "local" && !settings.anchor && fix) {
        save({ anchor: fix });
      }
      if (settings.drawn) {
        const why = drawSaved(api, settings, points);
        if (why) {
          api.map.remove(LINE_KEY);
          save({ drawn: false });
          onMap.setValue(false);
          status.show(why, "err");
        } else {
          status.hide();
        }
      } else if (isAnchor) {
        status.hide();
      }
      paint();
    }

    function describe() {
      if (!points.length) {
        summary.hide();
        return;
      }
      const parts = [`${points.length} point${points.length === 1 ? "" : "s"}`];
      const res = toLngLat(points, settings.frame, settings.anchor, settings.axes, settings.utmZone);
      if (!res.error) parts.push(`${formatDistance(pathLength(res.coords))} long`);
      const heights = heightRange(points, settings.frame, settings.axes);
      if (heights) parts.push(`heights ${formatLength(heights.lo)} to ${formatLength(heights.hi)}`);
      summary.show(parts.join(", ") + ".", "");
    }

    function setSelect(sel, value) {
      if (sel.value !== value) sel.value = value;
      if (sel.corvusSelect && typeof sel.corvusSelect.refresh === "function") sel.corvusSelect.refresh();
    }

    function paint() {
      fileName.textContent = settings.file || "No file chosen";
      fileName.title = fileName.textContent;
      utmBox.hidden = settings.frame !== "utm";
      localBox.hidden = settings.frame !== "local";
      setSelect(frameSelect, settings.frame);
      setSelect(utmZoneSelect, settings.utmZone);
      setSelect(axesSelect, settings.axes);
      anchorText.textContent = formatAnchor(settings.anchor);
      anchorBtn.disabled = !fix;
      anchorBtn.title = fix
        ? "Take the aircraft's position and heading as 0, 0, 0 now"
        : "No aircraft position yet. Connect and wait for a GPS fix.";
      swatchEls.forEach((b) => {
        const on = b.dataset.color === settings.color;
        b.classList.toggle("selected", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
      });
      onMap.setValue(settings.drawn);
      const hasPoints = points.length >= 2;
      fitBtn.disabled = !hasPoints;
      clearBtn.disabled = !hasPoints && !settings.file;
      describe();
    }

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        status.show(`${file.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`, "err");
        return;
      }
      ui.setBusy(chooseBtn, true);
      readFileText(file).then((text) => {
        if (cancelled) return;
        const parsed = parseTrajectory(text);
        if (parsed.error) {
          status.show(`${file.name}: ${parsed.error}`, "err");
          return;
        }
        points = parsed.points;
        const notes = [];
        if (parsed.skipped) {
          notes.push(`${parsed.skipped} line${parsed.skipped === 1 ? " was" : "s were"} passed over ` +
            `(the first is line ${parsed.firstSkipped}).`);
        }
        if (parsed.thinned) {
          notes.push(`The file has ${parsed.total} points. One in every ` +
            `${Math.ceil(parsed.total / MAX_POINTS)} is drawn.`);
        }
        save({ file: file.name, points: encodePoints(points) });
        if (notes.length) status.show(notes.join(" "), "warn");
        else status.hide();
        if (settings.drawn) update({});
        else paint();
      }).catch((err) => {
        if (!cancelled) status.show((err && err.message) || "Could not read the file.", "err");
      }).finally(() => {
        ui.setBusy(chooseBtn, false);
      });
    });

    startRecording(api);
    const unsubscribe = typeof api.subscribe === "function"
      ? api.subscribe((state) => {
        const next = anchorFromState(state);
        if (!!next !== !!fix) { fix = next; paint(); } else { fix = next; }
      })
      : null;
    fix = anchorFromState(typeof api.getState === "function" ? api.getState() : null);

    paint();

    containerEl._tvDestroy = function () {
      cancelled = true;
      if (typeof unsubscribe === "function") unsubscribe();
      containerEl._tvDestroy = null;
    };
  }

  function destroy(containerEl) {
    if (containerEl && typeof containerEl._tvDestroy === "function") containerEl._tvDestroy();
  }

  return {
    init, destroy, start,
    splitFields, parseTrajectory, encodePoints, decodePoints,
    localToLngLat, utmToLngLat, recordFlown, buildComparison, deviation, flown, toLngLat, pathLength, heightRange, anchorFromState, normalizeSettings,
    FRAMES, UTM_ZONES, COLORS, AXES, MAX_POINTS, LINE_KEY,
  };
})();

if (window.Corvus && Corvus.plugins && typeof Corvus.plugins.register === "function") {
  Corvus.plugins.register("trajectory-viewer", {
    name: "Trajectory Viewer",
    icon: "spline",
    description: "Draws a trajectory from a file on the Home map, under the flown track",
    start: function (api) { Corvus.pluginTrajectory.start(api); },
    init: function (containerEl, api) { Corvus.pluginTrajectory.init(containerEl, api); },
    destroy: function (containerEl) { Corvus.pluginTrajectory.destroy(containerEl); },
  });
}
