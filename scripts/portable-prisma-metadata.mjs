/** Strip generator provenance paths while preserving the generated runtime config.
 * @param {string} source @returns {string} */
export function portablePrismaMetadata(source) {
  const marker = 'const config = ';
  const markerOffset = source.indexOf(marker);
  if (markerOffset < 0) throw Error('Generated Prisma config was not found.');
  const start = source.indexOf('{', markerOffset + marker.length);
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) { end = index + 1; break; }
  }
  if (start < 0 || end < 0) throw Error('Generated Prisma config is incomplete.');
  const config = JSON.parse(source.slice(start, end));
  if (typeof config.generator?.output?.value !== 'string' || typeof config.generator?.sourceFilePath !== 'string') {
    throw Error('Generated Prisma provenance fields were not found.');
  }
  config.generator.output.value = '.';
  config.generator.sourceFilePath = 'schema.prisma';
  return source.slice(0, start) + JSON.stringify(config, null, 2) + source.slice(end);
}
