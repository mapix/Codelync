import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const state = vi.hoisted(() => ({ directory: '', local: true, reads: 0, readBudget: 0, opens: 0,
    afterRead: null as null | ((path: string) => Promise<void>) }));
const presign = vi.hoisted(() => vi.fn(async () => 'https://s3.invalid/legacy-download'));
vi.mock('@/storage/db', () => ({ db: { session: { findFirst: vi.fn(async ({ where }: any) =>
    where.id === 's1' && where.accountId === 'u1' ? { id: 's1', accountId: 'u1' } : null) } } }));
vi.mock('@/storage/files', () => ({ isLocalStorage: () => state.local, getLocalFilesDir: () => state.directory,
    putLocalFile: vi.fn(), s3client: { presignedGetObject: presign }, s3bucket: 'fixture' }));
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        state.opens++;
        const handle = await actual.open(...args), original = handle.read.bind(handle);
        handle.read = (async (...readArgs: any[]) => {
            state.reads++; state.readBudget += typeof readArgs[2] === 'number' ? readArgs[2] : 0;
            const result = await (original as any)(...readArgs);
            const after = state.afterRead; state.afterRead = null;
            if (after) await after(String(args[0]));
            return result;
        }) as typeof handle.read;
        return handle;
    } };
});
import { attachmentRoutes } from './attachmentRoutes';
import { MAX_CAPPED_ATTACHMENT_BYTES, statCappedLocalAttachment } from '@/storage/cappedAttachments';

const VIDEO_CIPHERTEXT_LIMIT = 1_000_040;
let app: Fastify;
const headers = { 'x-user-id': 'u1' };
const ref = 'sessions/s1/attachments/video.enc';
const postURL = '/v1/sessions/s1/attachments/request-download';
const getURL = '/v1/sessions/s1/attachments/video.enc';
const fixturePath = () => join(state.directory, ref);
beforeEach(async () => {
    state.directory = await mkdtemp(join(tmpdir(), 'codelync-capped-attachment-'));
    await mkdir(join(state.directory, 'sessions/s1/attachments'), { recursive: true });
    state.local = true; state.reads = 0; state.readBudget = 0; state.opens = 0; state.afterRead = null;
    presign.mockClear();
    const raw = fastify(); raw.setValidatorCompiler(validatorCompiler); raw.setSerializerCompiler(serializerCompiler);
    app = raw.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    app.decorate('authenticate', async (request: any, reply: any) => {
        if (typeof request.headers['x-user-id'] !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = request.headers['x-user-id'];
    });
    attachmentRoutes(app); await app.ready();
});
afterEach(async () => { await app.close(); await rm(state.directory, { recursive: true, force: true }); });

it('stat-gates exactly 1,000,040 encrypted bytes with no body read, then serves the same bounded descriptor', async () => {
    await writeFile(fixturePath(), Buffer.alloc(VIDEO_CIPHERTEXT_LIMIT, 7));
    const response = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref, maxBytes: VIDEO_CIPHERTEXT_LIMIT } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ downloadUrl: `http://localhost:80${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`,
        maxBytes: VIDEO_CIPHERTEXT_LIMIT, encryptedSize: VIDEO_CIPHERTEXT_LIMIT });
    expect(state.reads).toBe(0);
    const downloaded = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`, headers });
    expect(downloaded.statusCode).toBe(200); expect(downloaded.rawPayload.length).toBe(VIDEO_CIPHERTEXT_LIMIT);
    expect(state.readBudget).toBeLessThanOrEqual(VIDEO_CIPHERTEXT_LIMIT);
});
it('rejects +1 in POST and GET before reading file bytes or returning any download URL', async () => {
    await writeFile(fixturePath(), Buffer.alloc(VIDEO_CIPHERTEXT_LIMIT + 1));
    const post = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref, maxBytes: VIDEO_CIPHERTEXT_LIMIT } });
    expect(post.statusCode).toBe(413); expect(post.json().downloadUrl).toBeUndefined();
    const get = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`, headers });
    expect(get.statusCode).toBe(413); expect(get.rawPayload.length).toBeLessThan(200); expect(state.reads).toBe(0);
});
it('rechecks size in GET if a file grows after the POST proof', async () => {
    await writeFile(fixturePath(), Buffer.alloc(VIDEO_CIPHERTEXT_LIMIT));
    const post = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref, maxBytes: VIDEO_CIPHERTEXT_LIMIT } });
    expect(post.statusCode).toBe(200); await appendFile(fixturePath(), Buffer.alloc(1));
    const get = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`, headers });
    expect(get.statusCode).toBe(413); expect(state.reads).toBe(0);
});
it('does not publish buffered blob bytes when the same descriptor grows during the read', async () => {
    await writeFile(fixturePath(), Buffer.alloc(VIDEO_CIPHERTEXT_LIMIT));
    state.afterRead = async path => { await appendFile(path, Buffer.alloc(1)); };
    const get = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`, headers });
    expect(get.statusCode).toBe(413); expect(get.rawPayload.length).toBeLessThan(200);
    expect(state.readBudget).toBeLessThanOrEqual(VIDEO_CIPHERTEXT_LIMIT);
});
it('rejects an under-cap file mutation after the descriptor read instead of publishing inconsistent bytes', async () => {
    await writeFile(fixturePath(), Buffer.alloc(100));
    state.afterRead = async path => { await appendFile(path, Buffer.alloc(1)); };
    const get = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`, headers });
    expect(get.statusCode).toBe(409); expect(get.rawPayload.length).toBeLessThan(200);
});
it.each([0, -1, 1.5, MAX_CAPPED_ATTACHMENT_BYTES + 1])('rejects invalid POST cap %s without file access', async maxBytes => {
    const result = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref, maxBytes } });
    expect(result.statusCode).toBe(400); expect(state.opens).toBe(0); expect(state.reads).toBe(0);
});
it.each(['0', '-1', '1.5', 'NaN', String(MAX_CAPPED_ATTACHMENT_BYTES + 1)])('rejects invalid GET cap %s without file access', async value => {
    const result = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${value}`, headers });
    expect(result.statusCode).toBe(400); expect(state.opens).toBe(0);
});
it('rejects duplicate cap query values instead of selecting one', async () => {
    const result = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=1000040&maxBytes=1000041`, headers });
    expect(result.statusCode).toBe(400); expect(state.opens).toBe(0);
});
it('keeps session ownership and foreign-ref checks ahead of capped filesystem reads', async () => {
    const foreignRef = await app.inject({ method: 'POST', url: postURL, headers,
        payload: { ref: 'sessions/s2/attachments/foreign.enc', maxBytes: VIDEO_CIPHERTEXT_LIMIT } });
    expect(foreignRef.statusCode).toBe(400);
    const foreignOwner = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`, headers: { 'x-user-id': 'u2' } });
    expect(foreignOwner.statusCode).toBe(404); expect(state.opens).toBe(0);
});
it('missing capped attachments have no proof or bytes', async () => {
    const post = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref, maxBytes: VIDEO_CIPHERTEXT_LIMIT } });
    expect(post.statusCode).toBe(404); expect(post.json().downloadUrl).toBeUndefined();
    const get = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`, headers });
    expect(get.statusCode).toBe(404); expect(state.reads).toBe(0);
});
it('does not follow a local attachment symlink while issuing capped proof', async () => {
    const outside = join(state.directory, 'other.enc'); await writeFile(outside, Buffer.alloc(100));
    await symlink(outside, fixturePath());
    const post = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref, maxBytes: VIDEO_CIPHERTEXT_LIMIT } });
    expect(post.statusCode).toBe(404); expect(state.reads).toBe(0);
});
it('unknown size from a non-file attachment is rejected without a URL or byte read', async () => {
    await mkdir(fixturePath());
    const post = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref, maxBytes: VIDEO_CIPHERTEXT_LIMIT } });
    expect(post.statusCode).toBe(503); expect(post.json().downloadUrl).toBeUndefined(); expect(state.reads).toBe(0);
});
it('retains uncapped local downloads, including ordinary files larger than the video cap', async () => {
    await writeFile(fixturePath(), Buffer.alloc(VIDEO_CIPHERTEXT_LIMIT + 1));
    const post = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref } });
    expect(post.statusCode).toBe(200); expect(post.json().maxBytes).toBeUndefined(); expect(post.json().downloadUrl).not.toContain('?');
    const get = await app.inject({ method: 'GET', url: getURL, headers });
    expect(get.statusCode).toBe(200); expect(get.rawPayload.length).toBe(VIDEO_CIPHERTEXT_LIMIT + 1);
});
it('rejects capped S3 requests without presigning while preserving ordinary S3 requests', async () => {
    state.local = false;
    const post = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref, maxBytes: VIDEO_CIPHERTEXT_LIMIT } });
    expect(post.statusCode).toBe(501); expect(post.json().downloadUrl).toBeUndefined();
    const get = await app.inject({ method: 'GET', url: `${getURL}?maxBytes=${VIDEO_CIPHERTEXT_LIMIT}`, headers });
    expect(get.statusCode).toBe(501); expect(presign).not.toHaveBeenCalled(); expect(state.opens).toBe(0);
    const legacy = await app.inject({ method: 'POST', url: postURL, headers, payload: { ref } });
    expect(legacy.statusCode).toBe(200); expect(legacy.json()).toEqual({ downloadUrl: 'https://s3.invalid/legacy-download' });
    expect(presign).toHaveBeenCalledOnce();
});
it('validates the direct helper limit before any descriptor open', async () => {
    await expect(statCappedLocalAttachment(fixturePath(), Number.NaN)).rejects.toMatchObject({ status: 400 });
    expect(state.opens).toBe(0);
});
