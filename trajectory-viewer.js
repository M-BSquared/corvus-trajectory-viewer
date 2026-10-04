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
 *   epsg32632 / epsg25832 / epsg32633
 *          Projected metres, x is easting and y is northing, in UTM zone 32N
 *          (WGS84 or ETRS89, the usual German survey frame) or zone 33N.
 *   local  Metres in a frame of the aircraft's own: it is 0, 0, 0, x points
 *          the way its nose points, y to its right (FRD, as PX4 has it, z
 *          down) or to its left (FLU, as ROS has it, z up). The frame is taken
 *          from the aircraft's position and heading when the operator anchors
 *          it, and stays there: a reference that moved with the aircraft
 *          could never show how far the flight is from it.
 *
 * The line is drawn through api.map, which puts it under the flown track, so
 * while the aircraft flies its own path is always the line on top. The colour
 * is one of api.map.colors. z does not change the line (a map line lies on
 * the ground, in 3D as well); its range is shown with the point count.
 *
 * Everything is saved through api.saveSettings: the points (as text), the
 * file name, the frame, the anchor, the colour and whether the line is on the
 * map. start(api) draws a saved line when Corvus starts, so the reference is
 * there before anyone opens the plugin, and closing the plugin leaves it on
 * the map. Removing it is the operator's call, with the switch or Clear.
 *
 * Self-contained like every plugin: this script, its stylesheet
 * (trajectory-viewer.css, every class prefixed tv-), the Corvus.ui components
 * and the plugin api.
 */
Corvus.pluginTrajectory = (function () {
  const LINE_KEY = "trajectory";

  // Drawn with up to this many points; a longer file is thinned evenly, its
  // first and last point kept. Far more than a reference needs, and well
  // inside what the map and the plugin's config file carry comfortably.
  const MAX_POINTS = 50000;
  // A trajectory, not a point cloud.
  const MAX_FILE_BYTES = 20 * 1024 * 1024;

  const FRAMES = [
    { id: "wgs84", label: "WGS84 / EPSG:4326 (longitude, latitude)" },
    { id: "gps", label: "GPS (latitude, longitude)" },
    { id: "epsg32632", label: "UTM 32N / EPSG:32632 (easting, northing)" },
    { id: "epsg25832", label: "ETRS89 UTM 32N / EPSG:25832 (easting, northing)" },
    { id: "epsg32633", label: "UTM 33N / EPSG:32633 (easting, northing)" },
    { id: "local", label: "Local frame (metres from the aircraft)" },
  ];

  const AXES = [
    { id: "frd", label: "y to the right (FRD, PX4)" },
    { id: "flu", label: "y to the left (FLU, ROS)" },
  ];

  // WGS84 ellipsoid.
  const WGS84_A = 6378137;
  const WGS84_E2 = 6.69437999014e-3;

  // Projected frames: UTM zone and hemisphere. EPSG:25832 differs from 32632
  // only in the datum (ETRS89), under a metre from WGS84, so it shares the maths.
  const UTM = {
    epsg32632: { zone: 32, south: false },
    epsg25832: { zone: 32, south: false },
    epsg32633: { zone: 33, south: false },
  };

  const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const COMMENT_RE = /^(#|\/\/|%)/;

  // ---- reading a file ---------------------------------------------------

  /**
   * One line's fields. A semicolon or a tab is the separator when there is
   * one, and then a comma is a decimal comma; otherwise commas separate, and
   * failing that, spaces. A trailing separator leaves no empty last field.
   *
   * Pure, and exported for the test suite.
   */
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

  /**
   * Read a trajectory file's text into points.
   *
   * Returns {points, total, thinned, skipped, firstSkipped, hasZ, error}:
   * `points` is [[x, y, z|null], ...], `total` how many the file held before
   * thinning, `skipped` the lines that were neither a point, a comment nor
   * the header, `firstSkipped` the number of the first of them. `error` is
   * set, and `points` empty, when there is nothing to draw.
   *
   * Pure, and exported for the test suite.
   *
   * @param {string} text
   * @returns {Object}
   */
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
      // The first line that is not a point, before any point, is a header
      // ("x,y,z", "lon;lat"). Anything after that is a line that went wrong.
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

  /** Points as compact text for the settings file: one "x y z" per line. */
  function encodePoints(points) {
    return (points || []).map((p) => (p[2] === null || p[2] === undefined
      ? `${p[0]} ${p[1]}` : `${p[0]} ${p[1]} ${p[2]}`)).join("\n");
  }

  /** The other way: saved text back to points (empty on anything wrong). */
  function decodePoints(text) {
    if (typeof text !== "string" || !text) return [];
    return parseTrajectory(text).points;
  }

  // ---- from the file's frame to the map ---------------------------------

  /**
   * A point of the local frame to [lng, lat]. The frame's origin and heading
   * are `anchor` {lat, lon, heading}; x is along the heading, y to the right
   * for FRD and to the left for FLU. Metres become degrees through the
   * ellipsoid's radii of curvature at the origin, which is exact to well
   * under a metre over the few kilometres a local frame is used for.
   *
   * Pure, and exported for the test suite.
   */
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

  /**
   * UTM easting and northing in metres to [lng, lat] (inverse transverse
   * Mercator, Krueger series, millimetre accuracy inside a zone).
   *
   * Pure, and exported for the test suite.
   */
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

  /**
   * The points as [lng, lat] pairs for the map, or an error to show.
   *
   * Pure, and exported for the test suite.
   *
   * @param {Array} points [[x, y, z], ...]
   * @param {string} frame "wgs84" | "gps" | "local"
   * @param {Object|null} anchor {lat, lon, heading} for the local frame
   * @param {string} axes "frd" | "flu"
   * @returns {{coords: Array, error: string}}
   */
  function toLngLat(points, frame, anchor, axes) {
    const pts = points || [];
    if (frame === "local") {
      if (!anchor || !isFinite(anchor.lat) || !isFinite(anchor.lon)) {
        return { coords: [], error: "Anchor the frame at the aircraft first." };
      }
      return { coords: pts.map((p) => localToLngLat(p[0], p[1], anchor, axes)), error: "" };
    }
    if (UTM[frame]) {
      const { zone, south } = UTM[frame];
      const out = pts.map((p) => utmToLngLat(p[0], p[1], zone, south));
      if (out.every((c) => isFinite(c[0]) && isFinite(c[1]) && fitsDegrees(c[0], c[1])
        && p0InZoneRange(c))) {
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
        ? " These look like UTM metres. Choose EPSG:32632 or EPSG:25832 (zone 32), or EPSG:32633 (zone 33)."
        : " Metres from the aircraft go under Local frame.";
    }
    return { coords: [], error };
  }

  /** Length of a [lng, lat] path in metres (equirectangular per segment). */
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

  /** The height range the file's z gives, in metres up, or null without z.
   *  FRD's z points down, so its heights are -z. */
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

  /**
   * The local frame's anchor from a telemetry sample: the aircraft's position
   * and heading, or null while there is no real fix to take it from.
   *
   * Pure, and exported for the test suite.
   */
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

  // ---- saved settings ---------------------------------------------------

  /**
   * Saved settings, every field checked: a hand-edited or older config file
   * reads as the defaults rather than as a broken view.
   *
   * Pure, and exported for the test suite.
   */
  function normalizeSettings(raw, colors) {
    const r = raw && typeof raw === "object" ? raw : {};
    const palette = Array.isArray(colors) && colors.length ? colors : [{ id: "cyan" }];
    const a = r.anchor;
    const anchor = a && typeof a === "object" && isFinite(a.lat) && isFinite(a.lon)
      && Math.abs(a.lat) <= 90 && Math.abs(a.lon) <= 180
      ? { lat: Number(a.lat), lon: Number(a.lon), heading: Number(a.heading) || 0, at: Number(a.at) || 0 }
      : null;
    return {
      file: typeof r.file === "string" ? r.file : "",
      points: typeof r.points === "string" ? r.points : "",
      frame: FRAMES.some((f) => f.id === r.frame) ? r.frame : "wgs84",
      axes: AXES.some((x) => x.id === r.axes) ? r.axes : "frd",
      color: palette.some((c) => c.id === r.color) ? r.color : palette[0].id,
      anchor,
      drawn: r.drawn === true,
    };
  }

  function colorOf(api, id) {
    const colors = (api && api.map && api.map.colors) || [];
    const hit = colors.find((c) => c.id === id) || colors[0];
    return hit ? hit.color : "#2BC4E4";
  }

  /** Draw the saved line; the reason when it cannot be drawn, else "". */
  function drawSaved(api, settings, points) {
    const pts = points || decodePoints(settings.points);
    if (pts.length < 2) return "There is no trajectory to draw. Choose a file first.";
    const res = toLngLat(pts, settings.frame, settings.anchor, settings.axes);
    if (res.error) return res.error;
    const ok = api.map.drawLine(LINE_KEY, res.coords, { color: colorOf(api, settings.color), width: 3 });
    return ok ? "" : "The map did not take the line.";
  }

  /**
   * Runs once at start: a line that was on the map when Corvus closed is put
   * back, so the reference is there before the plugin is ever opened.
   */
  function start(api) {
    if (!api || !api.map || typeof api.getSettings !== "function") return;
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
    let fix = null;   // the anchor the aircraft would give right now

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
    // The file and what was read from it are one block, ruled off from the
    // settings below that work on it.
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
    localBox.className = "tv-local";
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
    const swatchEls = api.map.colors.map((c) => {
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
        // A local frame with no anchor yet takes the aircraft as it is now,
        // which is what turning the line on means for a frame of the aircraft.
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
        const res = toLngLat(points, settings.frame, settings.anchor, settings.axes);
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
            "UTM / EPSG:32632, 25832, 32633: metres, x is easting and y is " +
            "northing (zone 32N covers Munich, 33N the east of Bavaria).\n" +
            "GPS: degrees, latitude first, then longitude, the order a GPS " +
            "receiver or a phone shows.\n" +
            "Local frame: metres from the aircraft, along the way it faces.",
    }));
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

    /** A setting changed: save it, and redraw a line that is on the map. */
    function update(patch, isAnchor) {
      if (Object.keys(patch).length) save(patch);
      // A line on the map moved into a local frame that has no anchor yet
      // takes the aircraft as it is now, as turning the line on does.
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
      const res = toLngLat(points, settings.frame, settings.anchor, settings.axes);
      if (!res.error) parts.push(`${formatDistance(pathLength(res.coords))} long`);
      const heights = heightRange(points, settings.frame, settings.axes);
      if (heights) parts.push(`heights ${formatLength(heights.lo)} to ${formatLength(heights.hi)}`);
      summary.show(parts.join(", ") + ".", "");
    }

    /** A select set from code: the themed dropdown over it follows a
     *  "change" or a DOM mutation only, so it is told to look again. */
    function setSelect(sel, value) {
      if (sel.value !== value) sel.value = value;
      if (sel.corvusSelect && typeof sel.corvusSelect.refresh === "function") sel.corvusSelect.refresh();
    }

    function paint() {
      fileName.textContent = settings.file || "No file chosen";
      fileName.title = fileName.textContent;
      localBox.hidden = settings.frame !== "local";
      setSelect(frameSelect, settings.frame);
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
        // A new file on a line that is already showing replaces it at once.
        if (settings.drawn) update({});
        else paint();
      }).catch((err) => {
        if (!cancelled) status.show((err && err.message) || "Could not read the file.", "err");
      }).finally(() => {
        ui.setBusy(chooseBtn, false);
      });
    });

    // Whether the aircraft could anchor the frame right now.
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

  /** Tear down the view. The line stays on the map: that is the point of it. */
  function destroy(containerEl) {
    if (containerEl && typeof containerEl._tvDestroy === "function") containerEl._tvDestroy();
  }

  return {
    init, destroy, start,
    splitFields, parseTrajectory, encodePoints, decodePoints,
    localToLngLat, utmToLngLat, toLngLat, pathLength, heightRange, anchorFromState, normalizeSettings,
    FRAMES, AXES, MAX_POINTS, LINE_KEY,
  };
})();

// Registered as this script runs; the grid re-renders on every register().
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
