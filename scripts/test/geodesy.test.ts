import assert from "node:assert/strict";
import { test } from "node:test";
import {
  haversineMeters,
  localVectorMeters,
  localVectorMetersAtLatitude,
  metersToBboxDegreePads,
  metersToDegPad,
  metersToSquareProjectionDegPad,
  offsetLocalMeters,
} from "../../src/core/geodesy.js";
import { bboxAreaM2, padBboxMeters } from "../../src/core/bbox.js";

test("haversine returns zero for coincident points and handles the antimeridian", () => {
  assert.equal(haversineMeters(139.7, 35.6, 139.7, 35.6), 0);
  assert.ok(haversineMeters(179.999, 0, -179.999, 0) < 223);
});

test("haversine remains finite at antipodal coordinates", () => {
  const distance = haversineMeters(0, 0, 180, 0);
  assert.ok(Number.isFinite(distance));
  assert.ok(Math.abs(distance - Math.PI * 6_371_000) < 1e-6);
});

test("haversine clamps floating-point overshoot for valid near-antipodal coordinates", () => {
  const distance = haversineMeters(
    0,
    57.6036820752025,
    -179.99999999805,
    -57.60368207519802
  );
  assert.ok(Number.isFinite(distance));
  assert.ok(Math.abs(distance - Math.PI * 6_371_000) < 0.1);
});

test("degree padding keeps the intentionally distinct latitude approximations", () => {
  const meters = 100;
  const conservative = metersToDegPad(meters, 0);
  const squareProjection = metersToSquareProjectionDegPad(meters, 0);
  assert.equal(conservative, meters / 110_574);
  assert.equal(squareProjection, meters / 111_320);
  assert.ok(conservative > squareProjection);
});

test("local vectors name and preserve mean-latitude vs fixed-origin projections", () => {
  const from: [number, number] = [139, 10];
  const to: [number, number] = [139.01, 20];
  const meanLatitudeVector = localVectorMeters(from, to);
  const fixedOriginVector = localVectorMetersAtLatitude(from, to);

  assert.ok(meanLatitudeVector[0] < fixedOriginVector[0]);
  assert.equal(meanLatitudeVector[1], 10 * 110_574);
  assert.equal(fixedOriginVector[1], 10 * 110_574);
  assert.deepEqual(offsetLocalMeters(from, 0, 110_574), [139, 11]);
});

test("bbox degree pads and bbox helpers use the documented bbox approximation", () => {
  const meters = 50;
  const bbox: [number, number, number, number] = [139, 35, 140, 36];
  const pads = metersToBboxDegreePads(meters, (bbox[1] + bbox[3]) / 2);
  const padded = padBboxMeters(bbox, meters);
  assert.equal(pads.latitude, meters / 110_540);
  assert.ok(Math.abs(bbox[0] - padded[0] - pads.longitude) < 1e-13);
  assert.ok(Math.abs(bbox[1] - padded[1] - pads.latitude) < 1e-13);
  assert.ok(bboxAreaM2(bbox) > 0);
});

test("bbox padding rejects negative and non-finite distances", () => {
  const bbox: [number, number, number, number] = [139, 35, 140, 36];
  for (const invalidDistance of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => padBboxMeters(bbox, invalidDistance), RangeError);
  }
});
