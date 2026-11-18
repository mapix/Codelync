import { once } from 'node:events';

/** @param {import('node:child_process').ChildProcess[]} children @param {number} [waitMs] @param {number} [killWaitMs] */
export async function stopOwnedChildren(children, waitMs = 5000, killWaitMs = Math.max(2000, waitMs)) {
  const results = await Promise.allSettled(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    exited.catch(() => {});
    child.kill('SIGTERM');
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    try {
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      if (child.exitCode === null && child.signalCode === null) {
        // 强制结束也必须等真实 exit；发出信号不能充当数据库 writer 已退出的证据，并给 exit 设显式上限避免永久挂死。
        if (!child.kill('SIGKILL')) {
          if (child.exitCode !== null || child.signalCode !== null) return;
          throw Error('owned-child-stop-unconfirmed');
        }
        /** @type {ReturnType<typeof setTimeout>|undefined} */ let killTimer;
        try {
          await Promise.race([exited, new Promise(resolve => { killTimer = setTimeout(resolve, killWaitMs); })]);
        } finally {
          if (killTimer) clearTimeout(killTimer);
        }
        if (child.exitCode === null && child.signalCode === null) throw Error('owned-child-stop-unconfirmed');
      }
    } finally { if (timer) clearTimeout(timer); }
  }));
  if (results.some(result => result.status === 'rejected')) throw Error('owned-child-stop-unconfirmed');
}

/** Cleanup failures must not orphan the owned database process or release its lease early.
 * @param {(()=>unknown|Promise<unknown>)[]} resources
 * @param {()=>Promise<unknown>} stopChildren
 * @param {()=>Promise<unknown>} releaseLease */
export async function closeOwnedResources(resources, stopChildren, releaseLease) {
  let failure;
  for (const close of resources) { try { await close(); } catch (error) { failure ??= error; } }
  await stopChildren();
  await releaseLease();
  if (failure) throw failure;
}
