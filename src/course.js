// course.js
// Distance-based course definition. Each segment has a length (m) and a
// constant grade (%). Real courses would stream this from a route file;
// this is a sample loop with a warm-up, a climb, a fast descent, and a
// rolling finish so every code path (climbing/descending/flat) gets exercised.

// Grades are chosen so total climb and total descent cancel out exactly,
// so the loop returns to the same elevation every lap (no visual "cliff"
// at the wrap-around point).
export const COURSE = {
  name: "Kestrel Ridge Loop",
  segments: [
    { length: 500, grade: 0.0 },   // flat start
    { length: 700, grade: 4.0 },   // easing up
    { length: 600, grade: 8.0 },   // steady climb
    { length: 400, grade: 10.0 },  // steep ramp
    { length: 300, grade: 3.0 },   // short recovery
    { length: 900, grade: -9.0 },  // sustained descent
    { length: 500, grade: -6.0 },  // descent continues
    { length: 700, grade: -2.0 },  // gentle downhill tail
    { length: 800, grade: 0.0 },   // rolling flat
    { length: 600, grade: 0.0 },   // flat sprint to the line
  ],
};

// Precompute cumulative start distance for each segment for fast lookup.
function buildIndex(course) {
  let cursor = 0;
  const indexed = course.segments.map((seg) => {
    const withStart = { ...seg, start: cursor, end: cursor + seg.length };
    cursor += seg.length;
    return withStart;
  });
  return { segments: indexed, totalLength: cursor };
}

export const COURSE_INDEXED = buildIndex(COURSE);

/**
 * Returns the grade (%) at a given distance along the course.
 * Distance wraps around (modulo total length) so the loop repeats.
 */
export function gradeAtDistance(distanceMeters) {
  const total = COURSE_INDEXED.totalLength;
  let d = distanceMeters % total;
  if (d < 0) d += total;
  const segs = COURSE_INDEXED.segments;
  // Linear scan is fine at this segment count; swap for binary search
  // if a course ever grows into the thousands of segments.
  for (let i = 0; i < segs.length; i++) {
    if (d >= segs[i].start && d < segs[i].end) return segs[i].grade;
  }
  return segs[segs.length - 1].grade;
}

/** Returns { index, segment, distanceIntoSegment } for the given distance. */
export function segmentAtDistance(distanceMeters) {
  const total = COURSE_INDEXED.totalLength;
  let d = distanceMeters % total;
  if (d < 0) d += total;
  const segs = COURSE_INDEXED.segments;
  for (let i = 0; i < segs.length; i++) {
    if (d >= segs[i].start && d < segs[i].end) {
      return { index: i, segment: segs[i], distanceIntoSegment: d - segs[i].start };
    }
  }
  const last = segs.length - 1;
  return { index: last, segment: segs[last], distanceIntoSegment: segs[last].length };
}

export const COURSE_TOTAL_LENGTH = COURSE_INDEXED.totalLength;

// Precompute cumulative elevation at each segment's start so both the 3D
// road mesh and the avatar's vertical position can look it up cheaply.
function buildElevationTable(indexed) {
  let elevation = 0;
  return indexed.segments.map((seg) => {
    const startElevation = elevation;
    elevation += seg.length * (seg.grade / 100);
    return startElevation;
  });
}
const ELEVATION_AT_SEGMENT_START = buildElevationTable(COURSE_INDEXED);

/** Returns elevation (m) at a given distance along the course. */
export function elevationAtDistance(distanceMeters) {
  const total = COURSE_INDEXED.totalLength;
  let d = distanceMeters % total;
  if (d < 0) d += total;
  const segs = COURSE_INDEXED.segments;
  for (let i = 0; i < segs.length; i++) {
    if (d >= segs[i].start && d < segs[i].end) {
      const intoSegment = d - segs[i].start;
      return ELEVATION_AT_SEGMENT_START[i] + intoSegment * (segs[i].grade / 100);
    }
  }
  const last = segs.length - 1;
  return ELEVATION_AT_SEGMENT_START[last] + segs[last].length * (segs[last].grade / 100);
}
