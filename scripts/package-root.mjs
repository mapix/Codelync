import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Resolve production package files even when exports expose only native binaries.
 * @param {string} name @param {string} from @returns {Promise<{folder:string,data:Record<string,any>}>} */
export async function productionPackageRoot(name, from) {
  const req = createRequire(join(from, 'package.json'));
  let entry;
  const unavailable = (/** @type {any} */ error) => ['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code);
  try { entry = req.resolve(name + '/package.json'); }
  catch (error) { if (!unavailable(error)) throw error; try { entry = req.resolve(name); } catch (error) { if (!unavailable(error)) throw error; /* Native-only exports have no default entry. */ } }
  if (entry) {
    let folder = dirname(await realpath(entry));
    while (folder !== dirname(folder)) {
      try { const data = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')); if (data.name === name) return { folder, data }; }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; /* Continue to the owning manifest. */ }
      folder = dirname(folder);
    }
  }
  // package.json 的导出限制不代表依赖未安装；按 Node 自己的搜索路径读取打包清单。
  for (const base of req.resolve.paths(name) ?? []) {
    try {
      const folder = await realpath(join(base, name)), data = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
      if (data.name === name) return { folder, data };
    } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
  }
  throw Object.assign(Error(`Cannot resolve production dependency ${name}`), { code: 'MODULE_NOT_FOUND' });
}
