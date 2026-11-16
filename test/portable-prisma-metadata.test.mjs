import test from 'node:test';
import assert from 'node:assert/strict';
import { portablePrismaMetadata } from '../scripts/portable-prisma-metadata.mjs';

test('portable Prisma provenance preserves runtime/schema config and dirname code', () => {
  const config = {
    generator: { output: { value: '/Users/publisher/generated/client', fromEnvVar: null }, sourceFilePath: '/Users/publisher/prisma/schema.prisma', config: { engineType: 'library' } },
    relativePath: '../../../../../../packages/relay/prisma', inlineSchema: 'model A { value String } // "quoted"', inlineSchemaHash: 'schema-hash', relativeEnvPaths: { rootEnvPath: null }
  };
  const suffix = '\nconfig.dirname = __dirname;\n';
  const normalized = portablePrismaMetadata('const config = ' + JSON.stringify(config) + suffix);
  assert.ok(normalized.endsWith(suffix));
  const expected = structuredClone(config);
  expected.generator.output.value = '.';
  expected.generator.sourceFilePath = 'schema.prisma';
  const parsed = JSON.parse(normalized.slice('const config = '.length, -suffix.length));
  assert.deepEqual(parsed, expected);
  assert.doesNotMatch(normalized, /\/Users\/publisher/);
  assert.equal(portablePrismaMetadata(normalized), normalized);
});

test('portable Prisma normalization refuses missing or malformed generation metadata', () => {
  assert.throws(() => portablePrismaMetadata('const config = {'), /incomplete/);
  assert.throws(() => portablePrismaMetadata('const config = {}'), /provenance/);
  assert.throws(() => portablePrismaMetadata('module.exports = {}'), /not found/);
});
