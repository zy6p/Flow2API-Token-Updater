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

test('resolveAccountRefreshAt clamps to the minimum retry window', () => {
    const background = createBackground();
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);

    const refreshAt = background.resolveAccountRefreshAt({
        now,
        accountExpiryMs: now + (5 * 60 * 1000)
    });

    assert.equal(
        new Date(refreshAt).toISOString(),
        '2026-01-01T00:01:00.000Z'
    );
});

test('buildSafetyScheduleScope keeps the earliest automatic retry reason', () => {
    const background = createBackground();
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const scope = background.buildSafetyScheduleScope({
        cookieStoreId: 'firefox-container-7',
        periodicSyncMinutes: 240,
        periodicAt: now + (4 * 60 * 60 * 1000),
        accountExpiryMs: now + (24 * 60 * 60 * 1000),
        accountRefreshAt: now + (2 * 60 * 60 * 1000),
        browserCookieExpiryMs: now + (60 * 60 * 1000),
        heuristicProbeAt: now + (3 * 60 * 60 * 1000),
        waitingRetryAt: now + (5 * 60 * 1000)
    });

    assert.equal(scope.storeKey, 'firefox-container-7');
    assert.equal(scope.reason, 'waiting_session');
    assert.equal(
        new Date(scope.scheduledAt).toISOString(),
        '2026-01-01T00:05:00.000Z'
    );
    assert.equal(scope.periodicSyncMinutes, 240);
    assert.equal(scope.accountExpiryAt, '2026-01-02T00:00:00.000Z');
    assert.equal(scope.browserCookieExpiryAt, '2026-01-01T01:00:00.000Z');
    assert.equal(scope.periodicSyncAt, '2026-01-01T04:00:00.000Z');
    assert.equal(scope.waitingRetryAt, '2026-01-01T00:05:00.000Z');
});

test('buildSafetyScheduleCandidates only emits valid schedule choices', () => {
    const background = createBackground();
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);

    const candidates = background.buildSafetyScheduleCandidates({
        periodicAt: now + (4 * 60 * 60 * 1000),
        accountRefreshAt: null,
        heuristicProbeAt: now + (2 * 60 * 60 * 1000),
        waitingRetryAt: NaN
    });

    assert.deepEqual(toPlainJson(candidates), [
        {
            reason: 'periodic',
            when: now + (4 * 60 * 60 * 1000)
        },
        {
            reason: 'heuristic_probe',
            when: now + (2 * 60 * 60 * 1000)
        }
    ]);
    assert.deepEqual(
        toPlainJson(background.selectEarliestScheduleCandidate(candidates)),
        {
            reason: 'heuristic_probe',
            when: now + (2 * 60 * 60 * 1000)
        }
    );
});

test('buildSafetyScheduleCandidates includes metadata and error retries when they are earlier', () => {
    const background = createBackground();
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);

    const candidates = background.buildSafetyScheduleCandidates({
        periodicAt: now + (4 * 60 * 60 * 1000),
        metadataRetryAt: now + (60 * 60 * 1000),
        errorRetryAt: now + (15 * 60 * 1000)
    });

    assert.deepEqual(
        toPlainJson(background.selectEarliestScheduleCandidate(candidates)),
        {
            reason: 'sync_error',
            when: now + (15 * 60 * 1000)
        }
    );
});
