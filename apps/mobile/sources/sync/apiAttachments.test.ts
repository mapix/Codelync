import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/tokenStorage';
import {
    downloadEncryptedAttachment,
    requestAttachmentUpload,
    uploadEncryptedBlob,
} from './apiAttachments';
import { getAttachmentDiagnostic } from './attachmentDiagnostics';

const { appendFormFile, cleanupFormFile } = vi.hoisted(() => ({
    appendFormFile: vi.fn(),
    cleanupFormFile: vi.fn(),
}));

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.cluster-fluster.com',
    rewriteLoopbackHost: (url: string) => url,
}));

vi.mock('./uploadFormFile', () => ({
    appendFormFile,
}));
vi.mock('./peerNetwork', () => ({ credentialHeaders: (value: AuthCredentials) => ({ Authorization: `Bearer ${value.token}` }) }));

const credentials: AuthCredentials = {
    token: 'test-token',
    secret: 'test-secret',
};

const storageUrl = 'https://files.cluster-fluster.com/happy/session-1/ref?X-Amz-Signature=s3-secret&policy=secret-policy';
const apiBlobUrl = 'https://api.cluster-fluster.com/v1/sessions/session-1/attachments/blob?X-Amz-Signature=s3-secret';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    cleanupFormFile.mockReset();
    cleanupFormFile.mockResolvedValue(undefined);
    appendFormFile.mockReset();
    appendFormFile.mockResolvedValue(cleanupFormFile);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('requestAttachmentUpload', () => {
    it('classifies request-upload HTTP failures against the Happy API host', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toBe('request-upload failed: 500');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 500,
            statusText: 'Internal Server Error',
        });
    });

    it('keeps the request-upload 413 message while adding a diagnostic', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 413,
            statusText: 'Payload Too Large',
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            11 * 1024 * 1024,
        ));

        expect(error.message).toBe('Attachment too large (max 10MB)');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 413,
            statusText: 'Payload Too Large',
        });
    });

    it('classifies request-upload network failures against the Happy API host', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toBe('request-upload network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: 'Failed to fetch',
        });
    });

    it('classifies request-upload response parse failures without leaking credentials or refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            jsonError: new Error(`Unexpected token at ${apiBlobUrl} Bearer ${credentials.token} ref happy/session-1/ref`),
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toContain('request-upload response parse error');
        expect(error.message).toContain('Unexpected token');
        expect(error.message).toContain('[url:api.cluster-fluster.com]');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: expect.stringContaining('Unexpected token'),
        });
        expectNoAttachmentLeaks(error);
    });
});

describe('uploadEncryptedBlob', () => {
    it('classifies POST blob upload network failures without leaking presigned data', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: storageUrl,
            method: 'POST',
            formFields: {
                key: 'happy/session-1/ref',
                policy: 'secret-policy',
                'X-Amz-Signature': 's3-secret',
            },
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (POST) network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: 'Failed to fetch',
        });
        expect(cleanupFormFile).toHaveBeenCalledTimes(1);
        expectNoAttachmentLeaks(error);
    });

    it('classifies POST blob upload HTTP failures without leaking presigned query data', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        }));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: storageUrl,
            method: 'POST',
            formFields: {
                key: 'happy/session-1/ref',
                policy: 'secret-policy',
                'X-Amz-Signature': 's3-secret',
            },
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (POST) failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
        expect(cleanupFormFile).toHaveBeenCalledTimes(1);
        expectNoAttachmentLeaks(error);
    });

    it('classifies PUT blob upload network failures on the Happy API host without leaking query data', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: apiBlobUrl,
            method: 'PUT',
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (PUT) network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'PUT',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });
});

describe('downloadEncryptedAttachment', () => {
    it('video sends its cap and only GETs after exact encrypted-size and URL proof', async () => {
        const cap = 1_000_040, read = vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array(54) }).mockResolvedValueOnce({ done: true });
        fetchMock.mockResolvedValueOnce(response({ ok: true, json: { downloadUrl: storageUrl + '&maxBytes=' + cap, maxBytes: cap, encryptedSize: 54 } }))
            .mockResolvedValueOnce({ ...response({ ok: true }), body: { getReader: () => ({ read, releaseLock: vi.fn(), cancel: vi.fn() }) } });
        const bytes = await downloadEncryptedAttachment(credentials, 'session', 'ref', { maxBytes: cap, requireSizeGate: true, requireStreaming: true });
        expect(bytes.length).toBe(54); expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ref: 'ref', maxBytes: cap });
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.getAll('maxBytes')).toEqual([String(cap)]);
    });

    it.each(['missing-proof', 'wrong-cap', 'oversized', 'fractional-size', 'missing-url-cap', 'duplicate-url-cap'])('video %s response never starts a blob GET', async variant => {
        const cap = 1_000_040, reply: any = { downloadUrl: storageUrl + '&maxBytes=' + cap, maxBytes: cap, encryptedSize: 54 };
        if (variant === 'missing-proof') { delete reply.maxBytes; delete reply.encryptedSize; }
        if (variant === 'wrong-cap') reply.maxBytes = cap + 1;
        if (variant === 'oversized') reply.encryptedSize = cap + 1;
        if (variant === 'fractional-size') reply.encryptedSize = 54.5;
        if (variant === 'missing-url-cap') reply.downloadUrl = storageUrl;
        if (variant === 'duplicate-url-cap') reply.downloadUrl += '&maxBytes=' + cap;
        fetchMock.mockResolvedValueOnce(response({ ok: true, json: reply }));
        const error = await rejectedError(downloadEncryptedAttachment(credentials, 'session', 'ref', { maxBytes: cap, requireSizeGate: true, requireStreaming: true }));
        expect(getAttachmentDiagnostic(error)?.reason).toBe(variant === 'oversized' ? 'read-limit-exceeded' : 'size-gate-unavailable');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('video server 413 stays a size-limit failure with zero blob GET', async () => {
        fetchMock.mockResolvedValueOnce(response({ ok: false, status: 413 }));
        const error = await rejectedError(downloadEncryptedAttachment(credentials, 'session', 'ref', { maxBytes: 1_000_040, requireSizeGate: true }));
        expect(getAttachmentDiagnostic(error)?.reason).toBe('read-limit-exceeded'); expect(fetchMock).toHaveBeenCalledOnce();
    });
    it('aborts an oversized video response header before reading any body', async () => {
        const cancel = vi.fn().mockResolvedValue(undefined), getReader = vi.fn(), arrayBuffer = vi.fn();
        fetchMock.mockResolvedValueOnce(response({ ok: true, json: { downloadUrl: storageUrl } })).mockResolvedValueOnce({
            ...response({ ok: true }), headers: new Headers({ 'content-length': '1000041' }), body: { cancel, getReader }, arrayBuffer,
        });
        const error = await rejectedError(downloadEncryptedAttachment(credentials, 'session', 'ref', { maxBytes: 1_000_040, requireStreaming: true }));
        expect(getAttachmentDiagnostic(error)?.reason).toBe('read-limit-exceeded');
        expect(cancel).toHaveBeenCalledOnce(); expect(getReader).not.toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    });

    it.each([1_000_040, 1_000_041])('bounds unknown-sized video streams at %s ciphertext bytes and aborts excess', async size => {
        const read = vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array(1_000_040) })
            .mockResolvedValueOnce(size === 1_000_040 ? { done: true } : { done: false, value: new Uint8Array(1) })
            .mockResolvedValueOnce({ done: true });
        const cancel = vi.fn().mockResolvedValue(undefined), releaseLock = vi.fn(), arrayBuffer = vi.fn();
        fetchMock.mockResolvedValueOnce(response({ ok: true, json: { downloadUrl: storageUrl } })).mockResolvedValueOnce({
            ...response({ ok: true }), body: { getReader: () => ({ read, cancel, releaseLock }) }, arrayBuffer,
        });
        const result = downloadEncryptedAttachment(credentials, 'session', 'ref', { maxBytes: 1_000_040, requireStreaming: true });
        if (size === 1_000_040) { expect((await result).length).toBe(size); expect(cancel).not.toHaveBeenCalled(); }
        else { const error = await rejectedError(result); expect(getAttachmentDiagnostic(error)?.reason).toBe('read-limit-exceeded'); expect(cancel).toHaveBeenCalledOnce(); }
        expect(read).toHaveBeenCalledTimes(2); expect(releaseLock).toHaveBeenCalledOnce(); expect(arrayBuffer).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(size > 1_000_040);
    });

    it('video transport without a stream rejects without a full-body fallback', async () => {
        const arrayBuffer = vi.fn(), cancel = vi.fn().mockResolvedValue(undefined);
        fetchMock.mockResolvedValueOnce(response({ ok: true, json: { downloadUrl: storageUrl } })).mockResolvedValueOnce({ ...response({ ok: true }), body: { cancel }, arrayBuffer });
        await expect(downloadEncryptedAttachment(credentials, 'session', 'ref', { maxBytes: 1_000_040, requireStreaming: true })).rejects.toThrow('streaming unavailable');
        expect(arrayBuffer).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    });

    it('ordinary file transport retains its 10 MiB plus envelope fallback', async () => {
        const arrayBuffer = vi.fn().mockResolvedValue(new Uint8Array(10 * 1024 * 1024 + 40).buffer);
        fetchMock.mockResolvedValueOnce(response({ ok: true, json: { downloadUrl: storageUrl } })).mockResolvedValueOnce({ ...response({ ok: true }), arrayBuffer });
        const result = await downloadEncryptedAttachment(credentials, 'session', 'ref');
        expect(result.length).toBe(10 * 1024 * 1024 + 40); expect(arrayBuffer).toHaveBeenCalledOnce();
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ref: 'ref' });
    });
    it('classifies request-download network failures without leaking attachment refs', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('request-download network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies request-download HTTP failures without leaking attachment refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('request-download failed: 404');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 404,
            statusText: 'Not Found',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies request-download response parse failures without leaking attachment refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            jsonError: new Error(`Invalid JSON for ref happy/session-1/ref at ${apiBlobUrl}`),
        }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toContain('request-download response parse error');
        expect(error.message).toContain('Invalid JSON');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: expect.stringContaining('Invalid JSON'),
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download network failures without leaking presigned URL data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('Attachment download network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download HTTP failures without leaking presigned query data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockResolvedValueOnce(response({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
            }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('Attachment download failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download body read failures against storage without leaking presigned URL data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockResolvedValueOnce(response({
                ok: true,
                arrayBufferError: new Error(`stream reset for ${storageUrl} ref happy/session-1/ref`),
            }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toContain('Attachment download body read error');
        expect(error.message).toContain('stream reset');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: expect.stringContaining('stream reset'),
        });
        expectNoAttachmentLeaks(error);
    });
});

function response(init: {
    ok: boolean;
    status?: number;
    statusText?: string;
    json?: unknown;
    jsonError?: unknown;
    arrayBuffer?: ArrayBuffer;
    arrayBufferError?: unknown;
}): Response {
    return {
        ok: init.ok,
        headers: new Headers(),
        status: init.status ?? (init.ok ? 200 : 500),
        statusText: init.statusText ?? '',
        json: init.jsonError !== undefined
            ? vi.fn().mockRejectedValue(init.jsonError)
            : vi.fn().mockResolvedValue(init.json),
        arrayBuffer: init.arrayBufferError !== undefined
            ? vi.fn().mockRejectedValue(init.arrayBufferError)
            : vi.fn().mockResolvedValue(init.arrayBuffer ?? new Uint8Array().buffer),
    } as unknown as Response;
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (err) {
        expect(err).toBeInstanceOf(Error);
        return err as Error;
    }
    throw new Error('Expected promise to reject');
}

function expectNoAttachmentLeaks(error: Error): void {
    const serialized = JSON.stringify({
        message: error.message,
        diagnostic: getAttachmentDiagnostic(error),
    });

    expect(serialized).not.toContain(credentials.token);
    expect(serialized).not.toContain(`Bearer ${credentials.token}`);
    expect(serialized).not.toContain(storageUrl);
    expect(serialized).not.toContain(apiBlobUrl);
    expect(serialized).not.toContain('X-Amz-Signature');
    expect(serialized).not.toContain('s3-secret');
    expect(serialized).not.toContain('secret-policy');
    expect(serialized).not.toContain('happy/session-1/ref');
    expect(serialized).not.toContain('/happy/session-1/ref');
}
