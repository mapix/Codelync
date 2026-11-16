/** @typedef {Record<string,any>} Value */
/** Archive evidence is independent from source protocol/owner availability.
 * @param {unknown} source @param {unknown} [metadata] */
export function sourceArchived(source, metadata) {
  const row = source && typeof source === 'object' ? /** @type {Value} */ (source) : {};
  const value = metadata && typeof metadata === 'object' ? /** @type {Value} */ (metadata) : {};
  return row.archived === true || value.nativeSession?.archived === true || value.bridge?.source?.archived === true;
}

/** @param {unknown} source @param {unknown} [metadata] */
export function sourceCatalogVisible(source, metadata) {
  const value = metadata && typeof metadata === 'object' ? /** @type {Value} */ (metadata) : {};
  return !sourceArchived(source, metadata) && value.nativeSession?.catalogueAvailable !== false;
}
