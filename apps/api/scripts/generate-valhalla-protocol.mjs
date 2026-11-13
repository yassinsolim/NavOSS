#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import protobuf from 'protobufjs';

// Keep this pinned to the serving image, not the public development endpoint's current version.
const version = '3.8.2';
const sourceUrl = `https://raw.githubusercontent.com/valhalla/valhalla/${version}/proto/descriptors/`;
const sourceDirectory = process.argv[2];
const sourceNames = [
  'api',
  'common',
  'directions',
  'trip',
  'sign',
  'options',
  'info',
  'status',
  'matrix',
  'isochrone',
  'expansion',
  'incidents',
];
const fields = {
  'valhalla.Api': ['options', 'trip', 'directions', 'info'],
  'valhalla.Options': [
    'units',
    'language',
    'directionsType',
    'format',
    'action',
    'costingType',
    'costings',
    'locations',
    'dateTimeType',
    'dateTime',
    'filterAction',
    'filterAttributes',
    'shapeFormat',
    'alternates',
    'roundaboutExits',
    'pbfFieldSelector',
    'voiceInstructions',
    'turnLanes',
  ],
  'valhalla.PbfFieldSelector': ['options', 'trip', 'directions'],
  'valhalla.Costing': ['type', 'name', 'options'],
  'valhalla.Costing.Options': ['excludeUnpaved', 'useFerry', 'useHighways', 'useTolls'],
  'valhalla.Location': ['ll', 'type', 'heading', 'headingTolerance', 'radius'],
  'valhalla.LatLng': ['lat', 'lng'],
  'valhalla.Trip': ['routes'],
  'valhalla.TripRoute': ['legs'],
  'valhalla.TripLeg': ['node', 'shapeAttributes'],
  'valhalla.TripLeg.Node': ['edge'],
  'valhalla.TripLeg.Edge': [
    'name',
    'beginHeading',
    'endHeading',
    'beginShapeIndex',
    'endShapeIndex',
    'turnLanes',
  ],
  'valhalla.TripLeg.ShapeAttributes': ['speedLimit'],
  'valhalla.Directions': ['routes'],
  'valhalla.DirectionsRoute': ['legs'],
  'valhalla.DirectionsLeg': ['summary', 'maneuver', 'shape'],
  'valhalla.DirectionsLeg.Maneuver': [
    'type',
    'textInstruction',
    'streetName',
    'length',
    'time',
    'beginHeading',
    'beginShapeIndex',
    'endShapeIndex',
    'verbalPreTransitionInstruction',
    'verbalSuccinctTransitionInstruction',
    'sign',
    'roundaboutExitCount',
    'beginPathIndex',
    'turnDegree',
  ],
  'valhalla.Summary': ['length', 'time'],
  'valhalla.StreetName': ['value', 'isRouteNumber'],
  'valhalla.TripSign': [
    'exitNumbers',
    'exitOntoStreets',
    'exitTowardLocations',
    'exitNames',
    'guideOntoStreets',
    'guideTowardLocations',
    'junctionNames',
  ],
  'valhalla.TripSignElement': ['text'],
  'valhalla.TurnLane': ['directionsMask', 'state', 'activeDirection'],
  'valhalla.Info': ['errors'],
  'valhalla.CodedDescription': ['code'],
};
const root = new protobuf.Root();
const sourceSha256 = {};
for (const name of sourceNames) {
  let text;
  if (sourceDirectory === undefined) {
    const response = await fetch(`${sourceUrl}${name}.proto`);
    if (!response.ok) throw new Error(`Protocol source ${name}: HTTP ${response.status}`);
    text = await response.text();
  } else {
    text = await readFile(join(sourceDirectory, `${name}.proto`), 'utf8');
  }
  sourceSha256[`${name}.proto`] = createHash('sha256').update(text).digest('hex');
  protobuf.parse(text, root);
}
root.resolveAll();
const keep = new Set(Object.keys(fields));
for (const [name, fieldNames] of Object.entries(fields)) {
  const type = root.lookupType(name);
  for (const fieldName of fieldNames) {
    const field = type.fields[fieldName];
    if (field === undefined) throw new Error(`Missing pinned protocol field: ${name}.${fieldName}`);
    if (field.resolvedType !== null) keep.add(field.resolvedType.fullName.slice(1));
  }
}
function trim(node, name = '') {
  if (node.fields !== undefined) {
    const fieldNames = fields[name];
    if (fieldNames === undefined) throw new Error(`Unselected protocol message: ${name}`);
    node.fields = Object.fromEntries(
      fieldNames.map((fieldName) => [fieldName, node.fields[fieldName]]),
    );
    if (node.oneofs !== undefined) {
      node.oneofs = Object.fromEntries(
        Object.entries(node.oneofs)
          .map(([oneof, value]) => [
            oneof,
            { ...value, oneof: value.oneof.filter((fieldName) => fieldNames.includes(fieldName)) },
          ])
          .filter(([, value]) => value.oneof.length > 0),
      );
    }
  }
  if (node.nested !== undefined) {
    node.nested = Object.fromEntries(
      Object.entries(node.nested)
        .filter(([childName]) => {
          const childPath = name === '' ? childName : `${name}.${childName}`;
          return [...keep].some((kept) => kept === childPath || kept.startsWith(`${childPath}.`));
        })
        .map(([childName, child]) => [
          childName,
          trim(child, name === '' ? childName : `${name}.${childName}`),
        ]),
    );
  }
  return node;
}
const schema = trim(root.toJSON());
// The subset deliberately skips unconsumed fields, preserving their original wire ids/types.
const output = {
  version,
  sourceUrl,
  sourceSha256,
  license: 'MIT',
  licenseNotice:
    'Copyright (c) 2018 Valhalla contributors; Copyright (c) 2015-2017 Mapillary AB, Mapzen. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the Software), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  schema,
};
await writeFile(
  new URL(`../src/valhalla-proto-${version}.json`, import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);
