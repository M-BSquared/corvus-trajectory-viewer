"use strict";

/**
 * Frontend tests for the Trajectory Viewer plugin (plugins/trajectory-viewer).
 *
 *   PART A  reading a file: separators, decimal commas, headers, comments,
 *           lines that go wrong, thinning.
 *   PART B  the frames: WGS84 / EPSG:4326 (lon, lat), GPS (lat, lon), and the
 *           aircraft's local frame, whose maths is checked against distances
 *           and directions an operator could pace out.
 *   PART C  the plugin: start(api) puts a saved line back, the view's switch
 *           draws and removes it, a new file replaces a line that is showing.
 *
 * Run:
 *   node plugins/trajectory-viewer/tests/test_trajectory_viewer.js
 */

const assert = require("node:assert/strict");
const path = require("node:path");

// The Corvus checkout whose src/ this plugin runs against: the one around
// plugins/trajectory-viewer/, unless CORVUS_ROOT names another (the plugin kept in its own
// repository, say). tools/frontend_tests.js sets it.
const CORVUS = process.env.CORVUS_ROOT
  ? path.resolve(process.env.CORVUS_ROOT)
  : path.join(__dirname, "..", "..", "..");

global.window = global;
global.Corvus = {};
global.CustomEvent = class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
};
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.dispatchEvent = () => true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

function makeEl(tag) {
  const e = {
    tagName: String(tag || "div").toUpperCase(),
    className: "", children: [], dataset: {},
    type: "", hidden: false, disabled: false, value: "", id: "", title: "",
    tabIndex: 0, _attrs: {}, _listeners: {}, _isEl: true, parentNode: null, _text: "",
  };
  Object.defineProperty(e, "textContent", {
    get() { return e._text + e.children.map((c) => c.textContent || "").join(""); },
    set(v) { e._text = String(v); e.children.length = 0; },
  });
  let html = "";
  Object.defineProperty(e, "innerHTML", {
    get() { return html; },
    set(v) { html = String(v); e.children.length = 0; },
  });
  e.style = { _p: {}, setProperty(k, v) { e.style._p[k] = v; }, getPropertyValue: (k) => e.style._p[k] || "" };
  e.classList = {
    add(c) { const s = e.className.split(/\s+/).filter(Boolean); if (!s.includes(c)) s.push(c); e.className = s.join(" "); },
    remove(c) { e.className = e.className.split(/\s+/).filter((x) => x !== c).join(" "); },
    toggle(c, force) {
      const next = force === undefined ? !e.classList.contains(c) : !!force;
      if (next) e.classList.add(c); else e.classList.remove(c);
      return next;
    },
    contains(c) { return e.className.split(/\s+/).includes(c); },
  };
  e.appendChild = (c) => { c.parentNode = e; e.children.push(c); return c; };
  e.append = (...n) => n.forEach((x) => e.appendChild(x));
  e.insertBefore = (n, ref) => { const i = e.children.indexOf(ref); if (i < 0) e.children.push(n); else e.children.splice(i, 0, n); n.parentNode = e; return n; };
  e.removeChild = (c) => { const i = e.children.indexOf(c); if (i >= 0) e.children.splice(i, 1); c.parentNode = null; return c; };
  e.remove = () => { if (e.parentNode) e.parentNode.removeChild(e); };
  e.setAttribute = (k, v) => { e._attrs[k] = String(v); };
  e.getAttribute = (k) => (k in e._attrs ? e._attrs[k] : null);
  e.removeAttribute = (k) => { delete e._attrs[k]; };
  e.addEventListener = (t, cb) => { (e._listeners[t] = e._listeners[t] || []).push(cb); };
  e.removeEventListener = () => {};
  e.fire = (t, ev) => (e._listeners[t] || []).slice().forEach((cb) => cb(Object.assign({ target: e, preventDefault() {} }, ev)));
  e.click = () => e.fire("click");
  e.focus = () => {};
  e.querySelector = (sel) => all(e, sel)[0] || null;
  e.querySelectorAll = (sel) => all(e, sel);
  Object.defineProperty(e, "firstChild", { get: () => e.children[0] || null });
  return e;
}

/** ".a.b" or "tag", searched below `root`. */
function all(root, sel) {
  const out = [];
  const wantTag = sel[0] !== ".";
  const classes = sel.split(".").filter(Boolean);
  (function walk(list) {
    list.forEach((c) => {
      if (!c || !c._isEl) return;
      const own = c.className.split(/\s+/);
      if (wantTag ? c.tagName === sel.toUpperCase() : classes.every((x) => own.includes(x))) out.push(c);
      walk(c.children);
    });
  })(root.children);
  return out;
}

global.document = {
  createElement: makeEl,
  createElementNS: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), _isText: true }),
  createDocumentFragment: () => makeEl("fragment"),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  body: makeEl("body"),
  head: makeEl("head"),
};

require(path.join(CORVUS, "src", "js", "ui.js"));
require(path.join(CORVUS, "src", "js", "plugins.js"));
require("../trajectory-viewer.js");

const tv = Corvus.pluginTrajectory;
const R_LAT = 111132.95;   // metres per degree of latitude near 48 N, roughly

function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} is not within ${tol} of ${b}`);
}

// ===========================================================================
// PART A: reading a file
// ===========================================================================

function testFieldsSplitOnTheUsualSeparators() {
  assert.deepEqual(tv.splitFields("11.5,48.1,30"), ["11.5", "48.1", "30"]);
  assert.deepEqual(tv.splitFields("11.5, 48.1"), ["11.5", "48.1"]);
  assert.deepEqual(tv.splitFields("11,5;48,1;30"), ["11.5", "48.1", "30"], "semicolon file, decimal comma");
  assert.deepEqual(tv.splitFields("11,5\t48,1"), ["11.5", "48.1"], "tab file, decimal comma");
  assert.deepEqual(tv.splitFields("  11.5   48.1  2 "), ["11.5", "48.1", "2"]);
  assert.deepEqual(tv.splitFields("1,2,"), ["1", "2"], "a trailing separator adds nothing");
}

function testAFileReadsIntoPoints() {
  const parsed = tv.parseTrajectory([
    "# exported by a planner",
    "x,y,z",
    "11.0,48.0,10",
    "",
    "11.001,48.001",
    "// a comment",
    "% another",
    "11.002,48.002,12.5",
  ].join("\r\n"));
  assert.equal(parsed.error, "");
  assert.deepEqual(parsed.points, [[11, 48, 10], [11.001, 48.001, null], [11.002, 48.002, 12.5]]);
  assert.equal(parsed.skipped, 0, "the header and comments are not complaints");
  assert.equal(parsed.hasZ, true);
}

function testLinesThatGoWrongAreCountedWithTheFirstOnesNumber() {
  const parsed = tv.parseTrajectory("1 2\n3 4\n5 6 7 8\nhello\n9 10");
  assert.equal(parsed.points.length, 3);
  assert.equal(parsed.skipped, 2);
  assert.equal(parsed.firstSkipped, 3, "line numbers count from 1");
}

function testNothingToDrawSaysWhy() {
  assert.match(tv.parseTrajectory("").error, /No points found/);
  assert.match(tv.parseTrajectory("1 2 3 4\n5 6 7 8").error, /two or three numbers/);
  assert.match(tv.parseTrajectory("1 2").error, /at least two/);
  assert.deepEqual(tv.parseTrajectory("1 2").points, []);
  assert.match(tv.parseTrajectory("0x10 5\n1 2").error, /at least two/, "hex is not a number here");
}

function testALongFileIsThinnedKeepingBothEnds() {
  const n = tv.MAX_POINTS * 2 + 7;
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`${i} ${i}`);
  const parsed = tv.parseTrajectory(lines.join("\n"));
  assert.equal(parsed.thinned, true);
  assert.equal(parsed.total, n);
  assert.ok(parsed.points.length <= tv.MAX_POINTS + 1);
  assert.deepEqual(parsed.points[0], [0, 0, null]);
  assert.deepEqual(parsed.points[parsed.points.length - 1], [n - 1, n - 1, null], "the last point is kept");
}

function testPointsSurviveTheSettingsFile() {
  const points = [[11.123456789, 48.987654321, null], [-0.5, 1e-7, 123.25]];
  assert.deepEqual(tv.decodePoints(tv.encodePoints(points)), points, "no precision lost");
  assert.deepEqual(tv.decodePoints(""), []);
  assert.deepEqual(tv.decodePoints(null), []);
}

// ===========================================================================
// PART B: frames
// ===========================================================================

function testWgs84IsLongitudeThenLatitude() {
  const res = tv.toLngLat([[11.5, 48.1, null], [11.6, 48.2, null]], "wgs84", null, "frd");
  assert.equal(res.error, "");
  assert.deepEqual(res.coords, [[11.5, 48.1], [11.6, 48.2]]);
}

function testGpsIsLatitudeThenLongitude() {
  const res = tv.toLngLat([[48.1, 11.5, null], [48.2, 11.6, null]], "gps", null, "frd");
  assert.deepEqual(res.coords, [[11.5, 48.1], [11.6, 48.2]]);
}

function testTheWrongOrderIsNamed() {
  // Latitude first but read as WGS84: a latitude of 150 cannot be.
  const pts = [[48.1, 150.5, null], [48.2, 150.6, null]];
  assert.match(tv.toLngLat(pts, "wgs84", null, "frd").error, /Choose GPS/);
  const lonFirst = [[150.5, 48.1, null], [150.6, 48.2, null]];
  assert.match(tv.toLngLat(lonFirst, "gps", null, "frd").error, /Choose WGS84/);
  const metres = [[350, 1200, null], [400, 1300, null]];
  assert.match(tv.toLngLat(metres, "wgs84", null, "frd").error, /Local frame/);
}

function testUtm32nReadsEastingNorthing() {
  const res = tv.toLngLat([[696392.85, 5328667.09, 60], [696892.15, 5328724.20, 60]], "epsg32632", null, "frd");
  assert.equal(res.error, "");
  assert.ok(Math.abs(res.coords[0][0] - 11.6370) < 1e-6 && Math.abs(res.coords[0][1] - 48.0810) < 1e-6);
  assert.ok(Math.abs(res.coords[1][0] - 11.6437231) < 1e-6 && Math.abs(res.coords[1][1] - 48.0813593) < 1e-6);
  const same = tv.toLngLat([[696392.85, 5328667.09, 60]], "epsg25832", null, "frd");
  assert.deepEqual(same.coords[0], res.coords[0]);
}

function testUtmCentralMeridianAndZone33() {
  const c = tv.utmToLngLat(500000, 0, 33, false);
  assert.ok(Math.abs(c[0] - 15) < 1e-9 && Math.abs(c[1]) < 1e-9);
}

function testUtmNamesTheWrongFrame() {
  const utm = [[696392.85, 5328667.09, null], [696892.15, 5328724.2, null]];
  assert.match(tv.toLngLat(utm, "wgs84", null, "frd").error, /EPSG:32632/);
  const deg = [[11.5, 48.1, null], [11.6, 48.2, null]];
  assert.match(tv.toLngLat(deg, "epsg32632", null, "frd").error, /not UTM metres/);
}

function testTheLocalFrameNeedsAnAnchor() {
  const res = tv.toLngLat([[0, 0, 0], [10, 0, 0]], "local", null, "frd");
  assert.match(res.error, /Anchor the frame/);
  assert.deepEqual(res.coords, []);
}

const ANCHOR = { lat: 48.0, lon: 11.0, heading: 0 };

function testXIsWhereTheNosePoints() {
  const north = tv.localToLngLat(100, 0, ANCHOR, "frd");
  near((north[1] - 48) * R_LAT, 100, 0.5, "100 m ahead, facing north, is 100 m north");
  near(north[0], 11, 1e-9, "and not east or west");
  const east = tv.localToLngLat(100, 0, Object.assign({}, ANCHOR, { heading: 90 }), "frd");
  near(east[1], 48, 1e-9, "facing east, ahead is not north");
  assert.ok(east[0] > 11, "it is east");
  near(tv.pathLength([[11, 48], east]), 100, 0.5, "and 100 m away");
}

function testYIsRightForFrdAndLeftForFlu() {
  const right = tv.localToLngLat(0, 50, ANCHOR, "frd");
  assert.ok(right[0] > 11, "FRD: y is to the right, which is east when facing north");
  const left = tv.localToLngLat(0, 50, ANCHOR, "flu");
  assert.ok(left[0] < 11, "FLU: y is to the left, which is west when facing north");
  near(tv.pathLength([[11, 48], right]), 50, 0.5, "50 m to the side");
  // Facing east, the right hand points south.
  const south = tv.localToLngLat(0, 50, Object.assign({}, ANCHOR, { heading: 90 }), "frd");
  assert.ok(south[1] < 48);
  near(south[0], 11, 1e-9);
}

function testHeightsFollowTheAxes() {
  const pts = [[0, 0, -10], [1, 0, -30]];
  assert.deepEqual(tv.heightRange(pts, "local", "frd"), { lo: 10, hi: 30 }, "FRD z points down");
  assert.deepEqual(tv.heightRange(pts, "local", "flu"), { lo: -30, hi: -10 }, "FLU z points up");
  assert.deepEqual(tv.heightRange([[11, 48, 500], [11, 48, 520]], "wgs84", "frd"), { lo: 500, hi: 520 });
  assert.equal(tv.heightRange([[1, 2, null]], "wgs84", "frd"), null, "no z, no heights");
}

function testTheAnchorIsTheAircraftWithARealFix() {
  assert.equal(tv.anchorFromState(null), null);
  assert.equal(tv.anchorFromState({ connected: false, position: [11, 48], heading: 10 }), null);
  assert.equal(tv.anchorFromState({ connected: true, position: [0, 0], heading: 10 }), null, "no fix yet");
  const a = tv.anchorFromState({ connected: true, position: [11.5, 48.1], heading: -90 }, 1234);
  assert.deepEqual(a, { lat: 48.1, lon: 11.5, heading: 270, at: 1234 });
}

function testSavedSettingsAreChecked() {
  const colors = [{ id: "cyan" }, { id: "lime" }];
  const s = tv.normalizeSettings({
    frame: "utm", axes: "nwu", color: "red", drawn: "yes",
    anchor: { lat: 95, lon: 11 }, points: 5,
  }, colors);
  assert.deepEqual(s, {
    file: "", points: "", frame: "wgs84", axes: "frd", color: "cyan", anchor: null, drawn: false,
  });
  const ok = tv.normalizeSettings({
    frame: "local", axes: "flu", color: "lime", drawn: true, file: "a.csv",
    anchor: { lat: 48, lon: 11, heading: 45, at: 9 }, points: "1 2\n3 4",
  }, colors);
  assert.equal(ok.frame, "local");
  assert.equal(ok.color, "lime");
  assert.deepEqual(ok.anchor, { lat: 48, lon: 11, heading: 45, at: 9 });
}

// ===========================================================================
// PART C: the plugin
// ===========================================================================

function fakeApi(saved, state) {
  const drawn = {};
  const calls = [];
  let settings = Object.assign({}, saved || {});
  let subscriber = null;
  return {
    drawn, calls,
    saved: () => settings,
    push(s) { state = s; if (subscriber) subscriber(s); },
    getSettings: () => Object.assign({}, settings),
    saveSettings(patch, replace) {
      settings = replace ? Object.assign({}, patch) : Object.assign({}, settings, patch);
      return Promise.resolve(Object.assign({}, settings));
    },
    subscribe(cb) { subscriber = cb; return () => { subscriber = null; }; },
    getState: () => state || { connected: false, position: [0, 0] },
    map: {
      colors: Corvus.plugins.LINE_COLORS.map((c) => Object.assign({}, c)),
      drawLine(key, coords, opts) { calls.push(["draw", key]); if (coords.length < 2) return false; drawn[key] = { coords, opts }; return true; },
      remove(key) { calls.push(["remove", key]); delete drawn[key]; return true; },
      setVisible() { return true; },
      has: (key) => !!drawn[key],
      fit(coords) { calls.push(["fit", coords.length]); return true; },
    },
  };
}

const SAVED_LINE = { file: "route.csv", points: "11 48\n11.01 48.01", frame: "wgs84", color: "lime", drawn: true };

function testStartPutsASavedLineBack() {
  const api = fakeApi(SAVED_LINE);
  tv.start(api);
  assert.ok(api.drawn[tv.LINE_KEY], "drawn at start, without the plugin being opened");
  assert.deepEqual(api.drawn[tv.LINE_KEY].coords, [[11, 48], [11.01, 48.01]]);
  assert.equal(api.drawn[tv.LINE_KEY].opts.color, "#7BD389", "in the saved colour");

  const off = fakeApi(Object.assign({}, SAVED_LINE, { drawn: false }));
  tv.start(off);
  assert.equal(off.calls.length, 0, "a line that was off stays off");

  const local = fakeApi({
    points: "0 0\n100 0", frame: "local", axes: "frd", drawn: true,
    anchor: { lat: 48, lon: 11, heading: 90, at: 1 },
  });
  tv.start(local);
  const end = local.drawn[tv.LINE_KEY].coords[1];
  assert.ok(end[0] > 11, "the saved anchor, not wherever the aircraft is now");
}

function toggleOf(container) { return all(container, ".ui-toggle")[0]; }
function flush() { return new Promise((r) => setTimeout(r, 0)); }

async function testTheSwitchDrawsAndRemovesTheLine() {
  const api = fakeApi(Object.assign({}, SAVED_LINE, { drawn: false }));
  const container = makeEl("div");
  tv.init(container, api);
  const sw = toggleOf(container);
  assert.ok(sw, "the view has its switch");
  sw.click();
  await flush();
  assert.ok(api.drawn[tv.LINE_KEY], "on: drawn");
  assert.equal(api.saved().drawn, true, "and remembered");
  sw.click();
  await flush();
  assert.equal(api.drawn[tv.LINE_KEY], undefined, "off: removed");
  assert.equal(api.saved().drawn, false);
  tv.destroy(container);
}

async function testTheFrameIsADropdownThatRedrawsTheLine() {
  const api = fakeApi(SAVED_LINE);
  tv.start(api);
  const container = makeEl("div");
  tv.init(container, api);
  const selects = all(container, "select");
  const frame = selects.find((s) => s.id === "tvFrame");
  assert.ok(frame, "the coordinates are a dropdown");
  assert.deepEqual(frame.children.map((o) => o.value), ["wgs84", "gps", "local"]);
  assert.equal(frame.value, "wgs84");
  const local = all(container, ".tv-local")[0];
  assert.equal(local.hidden, true, "the axes are only there for the local frame");
  // The saved points read as latitude first are still on the globe.
  frame.value = "gps";
  frame.fire("change");
  await flush();
  assert.equal(api.saved().frame, "gps");
  assert.deepEqual(api.drawn[tv.LINE_KEY].coords[0], [48, 11], "redrawn in the new order");
  frame.value = "local";
  frame.fire("change");
  await flush();
  assert.equal(local.hidden, false);
  tv.destroy(container);
}

function testLongTextsAreBehindInfoIcons() {
  const api = fakeApi(SAVED_LINE);
  const container = makeEl("div");
  tv.init(container, api);
  assert.ok(all(container, ".ui-info").length >= 4, "file, coordinates, axes and map each have one");
  assert.equal(all(container, ".field-hint").length, 0, "no paragraph under a control");
  const cards = all(container, ".page-card");
  assert.equal(cards.length, 1, "one card: the file, and everything about the line");
  assert.ok(cards[0].children[0].classList.contains("tv-file"), "the file on top");
  tv.destroy(container);
}

async function testClosingThePluginLeavesTheLine() {
  const api = fakeApi(SAVED_LINE);
  tv.start(api);
  const container = makeEl("div");
  tv.init(container, api);
  tv.destroy(container);
  assert.ok(api.drawn[tv.LINE_KEY], "destroy does not take the line away");
  assert.ok(!api.calls.some((c) => c[0] === "remove"));
}

async function testALocalFrameTakesTheAircraftWhenTurnedOn() {
  const api = fakeApi({ points: "0 0\n10 0", frame: "local", axes: "frd", drawn: false },
    { connected: true, position: [11.2, 47.9], heading: 180 });
  const container = makeEl("div");
  tv.init(container, api);
  toggleOf(container).click();
  await flush();
  assert.ok(api.drawn[tv.LINE_KEY], "drawn from the aircraft as it is now");
  const saved = api.saved().anchor;
  assert.equal(saved.lat, 47.9);
  assert.equal(saved.heading, 180);
  assert.ok(api.drawn[tv.LINE_KEY].coords[1][1] < 47.9, "facing south, ahead is south");
  tv.destroy(container);
}

async function testWithoutAFixALocalLineIsRefused() {
  const api = fakeApi({ points: "0 0\n10 0", frame: "local", drawn: false });
  const container = makeEl("div");
  tv.init(container, api);
  const sw = toggleOf(container);
  sw.click();
  await flush();
  assert.equal(api.drawn[tv.LINE_KEY], undefined);
  assert.equal(sw.getAttribute("aria-checked"), "false", "the switch goes back");
  assert.match(container.textContent, /No aircraft position yet/);
  tv.destroy(container);
}

async function testANewFileReplacesTheLineShowing() {
  const api = fakeApi(SAVED_LINE);
  tv.start(api);
  const container = makeEl("div");
  tv.init(container, api);
  const input = all(container, ".tv-file-input")[0];
  input.files = [{ name: "new.txt", size: 40, text: () => Promise.resolve("12 49\n12.1 49.1\n12.2 49.2") }];
  input.fire("change");
  await flush();
  await flush();
  assert.equal(api.saved().file, "new.txt");
  assert.equal(api.drawn[tv.LINE_KEY].coords.length, 3, "the new file is on the map at once");
  assert.match(container.textContent, /3 points/);
  tv.destroy(container);
}

async function testABadFileKeepsWhatWasThere() {
  const api = fakeApi(SAVED_LINE);
  const container = makeEl("div");
  tv.init(container, api);
  const input = all(container, ".tv-file-input")[0];
  input.files = [{ name: "notes.txt", size: 10, text: () => Promise.resolve("hello\nworld") }];
  input.fire("change");
  await flush();
  await flush();
  assert.equal(api.saved().file, "route.csv", "the old file is kept");
  assert.match(container.textContent, /notes\.txt: No points found/);
  tv.destroy(container);
}

async function testClearForgetsTheFileAndTheLine() {
  const api = fakeApi(SAVED_LINE);
  tv.start(api);
  const container = makeEl("div");
  tv.init(container, api);
  const clear = all(container, "button").find((b) => b.textContent === "Clear");
  clear.click();
  await flush();
  assert.equal(api.drawn[tv.LINE_KEY], undefined);
  assert.equal(api.saved().points, "");
  assert.equal(api.saved().drawn, false);
  tv.destroy(container);
}

function testRegisteredWithAStartHook() {
  const listed = Corvus.plugins.list().find((p) => p.id === "trajectory-viewer");
  assert.ok(listed, "the plugin registers itself as it loads");
  assert.equal(listed.name, "Trajectory Viewer");
  assert.equal(listed.tab, false, "a card: it is opened to set up, not watched");
}

const tests = [
  testUtm32nReadsEastingNorthing,
  testUtmCentralMeridianAndZone33,
  testUtmNamesTheWrongFrame,
  testFieldsSplitOnTheUsualSeparators,
  testAFileReadsIntoPoints,
  testLinesThatGoWrongAreCountedWithTheFirstOnesNumber,
  testNothingToDrawSaysWhy,
  testALongFileIsThinnedKeepingBothEnds,
  testPointsSurviveTheSettingsFile,
  testWgs84IsLongitudeThenLatitude,
  testGpsIsLatitudeThenLongitude,
  testTheWrongOrderIsNamed,
  testTheLocalFrameNeedsAnAnchor,
  testXIsWhereTheNosePoints,
  testYIsRightForFrdAndLeftForFlu,
  testHeightsFollowTheAxes,
  testTheAnchorIsTheAircraftWithARealFix,
  testSavedSettingsAreChecked,
  testStartPutsASavedLineBack,
  testTheSwitchDrawsAndRemovesTheLine,
  testTheFrameIsADropdownThatRedrawsTheLine,
  testLongTextsAreBehindInfoIcons,
  testClosingThePluginLeavesTheLine,
  testALocalFrameTakesTheAircraftWhenTurnedOn,
  testWithoutAFixALocalLineIsRefused,
  testANewFileReplacesTheLineShowing,
  testABadFileKeepsWhatWasThere,
  testClearForgetsTheFileAndTheLine,
  testRegisteredWithAStartHook,
];

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      console.log(`ok   - ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL - ${t.name}`);
      console.error(`      ${err && err.stack ? err.stack.split("\n").join("\n      ") : err}`);
    }
  }
  if (failed) {
    console.error(`\n${failed}/${tests.length} trajectory viewer test(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} trajectory viewer tests passed.`);
  process.exit(0);
})();
