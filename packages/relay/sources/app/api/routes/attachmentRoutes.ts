/**
 * Attachment upload/download routes for image attachments in chat sessions.
 *
 * Two storage modes:
 * - S3: Returns presigned PUT/GET URLs. Server never touches file bytes.
 * - Local: Server accepts/serves encrypted blobs directly.
 *
 * No database records — attachments are identified by their ref path.
 * Cleanup happens when sessions are deleted (Phase 8).
 */
import { z } from 'zod';
import * as path from 'path';
import * as crypto from 'crypto';
import { Fastify } from '../types';
import { db } from '@/storage/db';
import { s3client, s3bucket, isLocalStorage, getLocalFilesDir, putLocalFile } from '@/storage/files';
import { CappedAttachmentError, MAX_CAPPED_ATTACHMENT_BYTES, readCappedLocalAttachment, readLocalAttachment, statCappedLocalAttachment } from '@/storage/cappedAttachments';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const PRESIGNED_TTL_SECONDS = 15 * 60; // 15 minutes (design spec)

// Per-user, per-process token bucket for request-upload. Best-effort flood
// protection — on a multi-process deploy each instance counts independently,
// so an attacker with N processes gets N×limit. Adequate as a backstop
// against a single-client loop generating presigned URLs forever.
const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 60;
const uploadRateState = new Map<string, { count: number; windowStart: number }>();

function firstHeaderToken(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const token = raw.split(',')[0]?.trim() ?? '';
    return token.length > 0 ? token : null;
}

function resolveForwardedProto(value: string | string[] | undefined): 'http' | 'https' {
    const token = firstHeaderToken(value)?.toLowerCase();
    return token === 'https' ? 'https' : 'http';
}

function resolveValidatedHost(value: string | string[] | undefined): string | null {
    const candidate = firstHeaderToken(value);
    if (!candidate || candidate.length > 255 || candidate.includes('..')) return null;
    if (/[\s\u0000-\u001f\u007f@/?#\\]/u.test(candidate)) return null;
    if (candidate.startsWith('[')) {
        if (!/^\[[0-9a-f:.]+\](?::[1-9]\d{0,4})?$/iu.test(candidate)) return null;
    } else if (!/^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?(?::[1-9]\d{0,4})?$/iu.test(candidate)) {
        return null;
    }
    try {
        const parsed = new URL(`http://${candidate}`);
        if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) {
            return null;
        }
        return candidate;
    } catch {
        return null;
    }
}

function isSafePathSegment(value: string): boolean {
    return value.length > 0 && !value.includes('..') && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

/**
 * Build the base URL the client should use to reach our local-mode upload /
 * download endpoints. Prefer an explicit PUBLIC_URL, then validated
 * x-forwarded-* (for deployments behind a proxy), then the Host header the
 * request itself arrived on. Falling back to localhost would make any
 * non-localhost client (a phone, another LAN device, a desktop pointing at
 * a dev IP) fail with a generic Network request failed when it tries to
 * follow the URL.
 */
function resolveBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    const publicUrl = process.env.PUBLIC_URL?.trim();
    if (publicUrl) {
        try {
            const parsed = new URL(publicUrl);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return publicUrl.replace(/\/+$/u, '');
            }
        } catch { /* fall back to validated request headers */ }
    }
    const host = resolveValidatedHost(request.headers['x-forwarded-host']) ?? resolveValidatedHost(request.headers.host);
    if (host) {
        const proto = resolveForwardedProto(request.headers['x-forwarded-proto']);
        return `${proto}://${host}`;
    }
    return `http://localhost:${process.env.PORT || '3005'}`;
}

function checkUploadRate(userId: string): boolean {
    const now = Date.now();
    const entry = uploadRateState.get(userId);
    if (!entry || now - entry.windowStart >= UPLOAD_RATE_WINDOW_MS) {
        uploadRateState.set(userId, { count: 1, windowStart: now });
        // Opportunistic prune so the map cannot grow forever from one-shot
        // users churning through the system.
        if (uploadRateState.size > 10_000) {
            for (const [k, v] of uploadRateState) {
                if (now - v.windowStart >= UPLOAD_RATE_WINDOW_MS) {
                    uploadRateState.delete(k);
                }
            }
        }
        return true;
    }
    if (entry.count >= UPLOAD_RATE_MAX) return false;
    entry.count++;
    return true;
}

export function attachmentRoutes(app: Fastify) {

    /**
     * Request an upload URL for an attachment.
     * Returns a ref (storage path) and an uploadUrl to PUT the encrypted blob to.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-upload', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                filename: z.string(),
                size: z.number().max(MAX_FILE_SIZE),
            }),
            response: {
                200: z.object({
                    ref: z.string(),
                    uploadUrl: z.string(),
                    method: z.enum(['PUT', 'POST']),
                    formFields: z.record(z.string(), z.string()).optional(),
                }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                429: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { size } = request.body;
        const userId = request.userId;

        if (!checkUploadRate(userId)) {
            return reply.code(429).send({ error: 'Too many upload requests. Try again in a minute.' });
        }

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (size > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        // Always .enc — encrypted opaque blobs, never trust client filename for path.
        const attachmentId = crypto.randomUUID();
        const attachmentFile = `${attachmentId}.enc`;
        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        if (isLocalStorage()) {
            // Local mode: client uploads to our own PUT endpoint (the server
            // enforces the size limit by inspecting the request body before
            // it hits disk, so PUT is fine here).
            const baseUrl = resolveBaseUrl(request);
            const uploadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ ref, uploadUrl, method: 'PUT' });
        } else {
            // S3 mode: presigned POST policy with content-length-range so S3
            // itself rejects oversize uploads — a presigned PUT cannot enforce
            // size and would let a client honest about size in the auth call
            // PUT 500MB at the URL afterwards.
            const policy = s3client.newPostPolicy();
            policy.setBucket(s3bucket);
            policy.setKey(ref);
            policy.setExpires(new Date(Date.now() + PRESIGNED_TTL_SECONDS * 1000));
            policy.setContentLengthRange(0, MAX_FILE_SIZE);
            const { postURL, formData } = await s3client.presignedPostPolicy(policy);
            return reply.send({
                ref,
                uploadUrl: postURL,
                method: 'POST',
                formFields: formData as Record<string, string>,
            });
        }
    });

    /**
     * Local storage: accept encrypted blob upload via PUT.
     * Only active when S3 is not configured.
     */
    app.put('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        schema: {
            params: z.object({
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
            response: {
                200: z.object({ ok: z.boolean() }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        if (!isLocalStorage()) {
            return reply.code(404).send({ error: 'Direct upload not available in S3 mode' });
        }

        const { sessionId, attachmentFile } = request.params;
        const userId = request.userId;

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (!isSafePathSegment(sessionId) || !isSafePathSegment(attachmentFile)) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const body = request.body as Buffer;
        if (body.length > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
        await putLocalFile(ref, body);

        return reply.send({ ok: true });
    });

    /**
     * Request a download URL for an attachment by ref. The client follows the
     * returned URL with a normal HTTP GET — in local mode it points back at
     * this server (auth-required), in S3 mode it is a presigned GET URL.
     * Pairs with /request-upload as the design-spec endpoint.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-download', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                ref: z.string(),
                maxBytes: z.number().int().positive().max(MAX_CAPPED_ATTACHMENT_BYTES).optional(),
            }),
            response: {
                200: z.object({
                    downloadUrl: z.string(),
                    maxBytes: z.number().int().positive().max(MAX_CAPPED_ATTACHMENT_BYTES).optional(),
                    encryptedSize: z.number().int().nonnegative().max(MAX_CAPPED_ATTACHMENT_BYTES).optional(),
                }),
                400: z.object({ error: z.string() }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                501: z.object({ error: z.string() }),
                503: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { ref, maxBytes } = request.body;
        const userId = request.userId;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // ref must live strictly under this session's attachments prefix —
        // otherwise a member of session A could craft a ref pointing into
        // session B and ride this endpoint's auth to read it.
        const expectedPrefix = `sessions/${sessionId}/attachments/`;
        if (!ref.startsWith(expectedPrefix)) {
            return reply.code(400).send({ error: 'Ref does not belong to this session' });
        }
        const attachmentFile = ref.slice(expectedPrefix.length);
        if (!isSafePathSegment(sessionId) || !isSafePathSegment(attachmentFile)) {
            return reply.code(400).send({ error: 'Invalid attachment ref' });
        }

        if (isLocalStorage()) {
            const baseUrl = resolveBaseUrl(request);
            const downloadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            if (maxBytes !== undefined) {
                try {
                    const encryptedSize = await statCappedLocalAttachment(path.join(getLocalFilesDir(), ref), maxBytes);
                    return reply.send({ downloadUrl: `${downloadUrl}?maxBytes=${maxBytes}`, maxBytes, encryptedSize });
                } catch (error) {
                    if (error instanceof CappedAttachmentError) return reply.code(error.status as 404 | 413 | 503).send({ error: error.message });
                    throw error;
                }
            }
            return reply.send({ downloadUrl });
        }
        if (maxBytes !== undefined) return reply.code(501).send({ error: 'Capped attachment download unavailable for S3 storage' });
        const downloadUrl = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
        return reply.send({ downloadUrl });
    });

    /**
     * Download an attachment. Returns the encrypted blob directly (local)
     * or a presigned GET URL redirect (S3). Backs the URL returned by
     * /request-download in local mode; clients can also call this directly.
     */
    app.get('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        schema: {
            params: z.object({
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
            querystring: z.object({
                maxBytes: z.string().regex(/^[1-9]\d*$/).transform(Number)
                    .pipe(z.number().int().positive().max(MAX_CAPPED_ATTACHMENT_BYTES)).optional(),
            }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId, attachmentFile } = request.params;
        const { maxBytes } = request.query;
        const userId = request.userId;

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (!isSafePathSegment(sessionId) || !isSafePathSegment(attachmentFile)) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        if (isLocalStorage()) {
            const fullPath = path.join(getLocalFilesDir(), ref);
            try {
                const bytes = maxBytes !== undefined
                    ? await readCappedLocalAttachment(fullPath, maxBytes)
                    : await readLocalAttachment(fullPath);
                return reply.type('application/octet-stream').header('Cache-Control', 'no-store').send(bytes);
            } catch (error) {
                if (error instanceof CappedAttachmentError) return reply.code(error.status).send({ error: error.message });
                throw error;
            }
        } else {
            if (maxBytes !== undefined) return reply.code(501).send({ error: 'Capped attachment download unavailable for S3 storage' });
            // S3 mode: redirect to presigned GET URL (15 min, per design).
            const url = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
            return reply.redirect(url);
        }
    });
}
