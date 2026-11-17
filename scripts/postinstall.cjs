const { execSync } = require('child_process');

// Apply patches to node_modules
require('../patches/fix-pglite-prisma-bytes.cjs');
require('../patches/fix-livekit-room-reuse.cjs');
require('../patches/expose-pierre-diffs-style.cjs');
require('../patches/force-preact-cjs.cjs');
require('../patches/fix-pierre-trees-preact-hooks.cjs');
require('../patches/fix-react-native-audio-api-size-t.cjs');
require('../patches/fix-flash-list-web-inversion.cjs').patchFlashListWeb();
require('../patches/fix-virtualized-list-stale-frame-offset.cjs').patchVirtualizedLists();

if (process.env.SKIP_CODELYNC_WIRE_BUILD === '1') {
  console.log('[postinstall] SKIP_CODELYNC_WIRE_BUILD=1, skipping @codelync/wire build');
  process.exit(0);
}

execSync('pnpm --filter @codelync/wire build', {
  stdio: 'inherit',
});
