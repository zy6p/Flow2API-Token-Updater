const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createHarness,
    loadBackground
} = require('../scripts/test_lib/background_harness');

function createBackground() {
    return loadBackground(createHarness());
}

function toPlainJson(value) {
    return JSON.parse(JSON.stringify(value));
}

test('shouldPreserveExistingToken only protects automatic refreshes with a still-valid access token', () => {
    const background = createBackground();

    assert.equal(
        background.shouldPreserveExistingToken(
            {
                status: 'success',
                atExpires: '2026-01-01T08:00:00.000Z'
            },
            'scheduled_check'
        ),
        true
    );

    assert.equal(
        background.shouldPreserveExistingToken(
            {
                status: 'success',
                atExpires: '2026-01-01T08:00:00.000Z'
            },
            'manual_sync'
        ),
        false
    );

    assert.equal(
        background.shouldPreserveExistingToken(
            {
                status: 'error',
                atExpires: '2026-01-01T08:00:00.000Z'
            },
            'scheduled_check'
        ),
        false
    );
});

test('resolveSharedConfigCandidate only reuses a config when every scoped entry matches', () => {
    const background = createBackground();

    assert.deepEqual(
        toPlainJson(background.resolveSharedConfigCandidate({
            '__default__': {
                baseUrl: 'mock-flow2api.local',
                connectionToken: 'shared-token'
            },
            'firefox-container-7': {
                baseUrl: 'https://mock-flow2api.local/manage',
                connectionToken: 'shared-token'
            }
        })),
        {
            baseUrl: 'https://mock-flow2api.local',
            connectionToken: 'shared-token'
        }
    );

    assert.equal(
        background.resolveSharedConfigCandidate({
            '__default__': {
                baseUrl: 'https://mock-flow2api.local',
                connectionToken: 'shared-token'
            },
            'firefox-container-9': {
                baseUrl: 'https://mock-flow2api.local',
                connectionToken: 'other-token'
            }
        }),
        null
    );
});

test('createWaitingSessionState keeps the last successful account identity for retries', () => {
    const background = createBackground();

    const waitingState = background.createWaitingSessionState(
        {
            syncedAt: '2026-01-01T00:00:00.000Z',
            email: 'known@example.com',
            atExpires: '2026-01-01T08:00:00.000Z',
            sessionExpiresAt: '2026-01-01T09:00:00.000Z',
            sessionFingerprint: 'st_deadbeef'
        },
        'scheduled_check'
    );

    assert.equal(waitingState.status, 'waiting_session');
    assert.equal(waitingState.reason, 'scheduled_check');
    assert.equal(waitingState.email, 'known@example.com');
    assert.equal(waitingState.atExpires, '2026-01-01T08:00:00.000Z');
    assert.equal(waitingState.sessionFingerprint, 'st_deadbeef');
});

test('resolveEffectiveStorePolicy keeps explicit choices and auto-managed store history', () => {
    const background = createBackground();

    assert.equal(
        background.resolveEffectiveStorePolicy({
            explicitPolicy: 'disabled'
        }),
        'disabled'
    );

    assert.equal(
        background.resolveEffectiveStorePolicy({
            lastSync: {
                status: 'success'
            }
        }),
        'auto'
    );

    assert.equal(
        background.resolveEffectiveStorePolicy({
            lastSync: {
                status: 'error'
            },
            sessionContext: {
                storeId: 'firefox-container-9',
                domain: 'labs.google',
                path: '/',
                name: '__Secure-next-auth.session-token'
            }
        }),
        'auto'
    );

    assert.equal(
        background.resolveEffectiveStorePolicy({
            lastSync: {
                status: 'waiting_session'
            }
        }),
        'observe'
    );
});
