#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
    FLOW2API_ORIGIN,
    FLOW2API_MANAGE_URL,
    LABS_URL,
    SESSION_COOKIE_NAME,
    createHarness,
    loadBackground
} = require('./test_lib/background_harness');

function buildGlobalConfig({
    baseUrl = FLOW2API_ORIGIN,
    adminToken = 'admin-token',
    connectionToken = 'connection-token'
} = {}) {
    return {
        globalFlow2ApiConfig: {
            baseUrl,
            adminToken,
            connectionToken
        }
    };
}

async function testGlobalConfigConnectsWithoutOpeningConsole() {
    const harness = createHarness();
    const background = loadBackground(harness);

    const result = await background.connectBaseUrl(FLOW2API_ORIGIN, 'admin-token');

    assert.equal(result.success, true);
    assert.equal(result.hasConnection, true);
    assert.equal(result.hasAdminToken, true);
    assert.equal(result.synced, false);
    assert.equal(result.lastSync.status, 'waiting_session');

    const stored = harness.localStorageArea.dump();
    assert.equal(stored.globalFlow2ApiConfig.baseUrl, FLOW2API_ORIGIN);
    assert.equal(stored.globalFlow2ApiConfig.adminToken, 'admin-token');
    assert.equal(stored.globalFlow2ApiConfig.connectionToken, 'connection-token');
    assert.equal(stored.lastSyncByStore.__default__.status, 'waiting_session');
    assert.equal(
        harness.createdTabs.filter((tab) => tab.url === FLOW2API_MANAGE_URL).length,
        0,
        'automatic connect should not open Flow2API manage tabs anymore'
    );
}

async function testSyncUsesGlobalConfigAcrossStores() {
    const harness = createHarness({
        cookies: [
            {
                name: SESSION_COOKIE_NAME,
                value: 'store-1-session',
                domain: 'labs.google',
                path: '/',
                storeId: 'firefox-container-1',
                firstPartyDomain: null,
                expirationDate: 1796054400
            },
            {
                name: SESSION_COOKIE_NAME,
                value: 'store-3-session',
                domain: 'labs.google',
                path: '/',
                storeId: 'firefox-container-3',
                firstPartyDomain: null,
                expirationDate: 1796054400
            }
        ],
        fetchHandler({ requestUrl, method, authHeader, body, createMockResponse }) {
            if (requestUrl.pathname === '/api/tokens/st2at' && method === 'POST' && authHeader === 'Bearer admin-token') {
                return createMockResponse(200, {
                    success: true,
                    email: `${body.st}@example.com`,
                    expires: body.st === 'store-1-session'
                        ? '2026-04-30T00:00:00.000Z'
                        : '2026-05-01T00:00:00.000Z'
                });
            }

            return null;
        }
    });
    const background = loadBackground(harness);

    await harness.localStorageArea.set(buildGlobalConfig());

    const store1 = await background.handleMessage({
        action: 'syncNow',
        cookieStoreId: 'firefox-container-1'
    });
    const store3 = await background.handleMessage({
        action: 'syncNow',
        cookieStoreId: 'firefox-container-3'
    });

    assert.equal(store1.success, true);
    assert.equal(store3.success, true);

    const stored = harness.localStorageArea.dump();
    assert.equal(stored.lastSyncByStore['firefox-container-1'].email, 'store-1-session@example.com');
    assert.equal(stored.lastSyncByStore['firefox-container-3'].email, 'store-3-session@example.com');

    const updateCalls = harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.deepEqual(
        updateCalls.map((call) => [call.body.session_token, call.authorization]),
        [
            ['store-1-session', 'Bearer connection-token'],
            ['store-3-session', 'Bearer connection-token']
        ]
    );
}

async function testPreviewUsesAdminTokenWithoutConsoleProbe() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'preview-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }]
    });
    const background = loadBackground(harness);

    await harness.localStorageArea.set(buildGlobalConfig());

    const setup = await background.getSetupData('default', {
        allowSessionMetadataLookup: true
    });

    assert.equal(setup.success, true);
    assert.equal(setup.hasAdminToken, true);
    assert.equal(setup.settings.lastSync.status, 'detected_session');
    assert.equal(setup.settings.lastSync.email, 'user@example.com');
    assert.equal(
        harness.createdTabs.filter((tab) => tab.url === FLOW2API_MANAGE_URL).length,
        0,
        'metadata preview should not create Flow2API manage tabs'
    );
}

async function testConnectionTokenRecoveryUsesAdminTokenInsteadOfConsole() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'recover-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }],
        fetchHandler({ requestUrl, method, authHeader, body, createMockResponse }) {
            if (requestUrl.pathname === '/api/plugin/update-token' && method === 'POST') {
                if (authHeader === 'Bearer stale-connection-token') {
                    return createMockResponse(403, {
                        message: 'connection token expired'
                    });
                }

                if (authHeader === 'Bearer refreshed-connection-token') {
                    return createMockResponse(200, {
                        success: true,
                        action: 'updated',
                        message: `Token updated for ${body.session_token}`
                    });
                }
            }

            if (requestUrl.pathname === '/api/plugin/config' && method === 'GET' && authHeader === 'Bearer admin-token') {
                return createMockResponse(200, {
                    config: {
                        connection_token: 'refreshed-connection-token'
                    }
                });
            }

            return null;
        }
    });
    const background = loadBackground(harness);

    await harness.localStorageArea.set(buildGlobalConfig({
        connectionToken: 'stale-connection-token'
    }));

    const result = await background.syncCurrentSession({
        reason: 'scheduled_check',
        allowLabsWakeup: false,
        allowConsoleWakeup: false,
        notifyOnError: false
    });

    assert.equal(result.success, true);
    assert.equal(result.lastSync.status, 'success');
    assert.equal(harness.localStorageArea.dump().globalFlow2ApiConfig.connectionToken, 'refreshed-connection-token');
    assert.equal(
        harness.createdTabs.filter((tab) => tab.url === FLOW2API_MANAGE_URL).length,
        0,
        'connection token recovery should stay on the API path'
    );
}

async function testGenericSyncErrorSchedulesQuickRetry() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'error-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }],
        fetchHandler({ requestUrl, method, createMockResponse }) {
            if (requestUrl.pathname === '/api/plugin/update-token' && method === 'POST') {
                return createMockResponse(500, {
                    message: 'server exploded'
                });
            }

            return null;
        }
    });
    const background = loadBackground(harness);

    await harness.localStorageArea.set(buildGlobalConfig());

    const result = await background.syncCurrentSession({
        reason: 'scheduled_check',
        allowLabsWakeup: false,
        allowConsoleWakeup: false,
        notifyOnError: false
    });

    assert.equal(result.success, false);
    assert.equal(result.lastSync.status, 'error');
    assert.equal(harness.alarms.length, 1);
    assert.equal(
        new Date(harness.alarms[0].when).toISOString(),
        '2026-01-01T00:15:00.000Z',
        'generic sync failures should retry sooner than the periodic safety window'
    );
}

async function testMetadataUnknownSchedulesHourlyProbe() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'metadata-unknown-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }]
    });
    const background = loadBackground(harness);

    await harness.localStorageArea.set(buildGlobalConfig({
        adminToken: '',
        connectionToken: 'connection-token'
    }));

    const result = await background.syncCurrentSession({
        reason: 'manual_sync',
        allowLabsWakeup: false,
        allowConsoleWakeup: false,
        notifyOnError: false
    });

    assert.equal(result.success, true);
    assert.equal(result.lastSync.status, 'success');
    assert.equal(result.lastSync.atExpires, null);
    assert.equal(harness.alarms.length, 1);
    assert.equal(
        new Date(harness.alarms[0].when).toISOString(),
        '2026-01-01T01:00:00.000Z',
        'missing expiry metadata should now trigger an earlier follow-up probe'
    );
}

async function testScheduledAlarmOnlyRunsDueStore() {
    const harness = createHarness({
        cookies: [
            {
                name: SESSION_COOKIE_NAME,
                value: 'waiting-store-session',
                domain: 'labs.google',
                path: '/',
                storeId: 'firefox-container-1',
                firstPartyDomain: null,
                expirationDate: 1796054400
            },
            {
                name: SESSION_COOKIE_NAME,
                value: 'healthy-store-session',
                domain: 'labs.google',
                path: '/',
                storeId: 'firefox-container-2',
                firstPartyDomain: null,
                expirationDate: 1796054400
            }
        ]
    });
    const background = loadBackground(harness);

    await harness.localStorageArea.set({
        ...buildGlobalConfig(),
        lastSyncByStore: {
            'firefox-container-1': {
                status: 'waiting_session',
                reason: 'scheduled_check',
                checkedAt: '2026-01-01T00:00:00.000Z',
                email: null,
                atExpires: null,
                sessionExpiresAt: null,
                sessionFingerprint: null,
                action: null,
                message: 'waiting'
            },
            'firefox-container-2': {
                status: 'success',
                reason: 'scheduled_check',
                syncedAt: '2026-01-01T00:00:00.000Z',
                email: 'healthy@example.com',
                atExpires: '2026-01-02T00:00:00.000Z',
                sessionExpiresAt: '2026-11-30T16:00:00.000Z',
                sessionFingerprint: background.fingerprintSessionToken('healthy-store-session'),
                action: 'updated',
                message: '同步成功'
            }
        }
    });

    await background.refreshSafetyAlarm();
    assert.equal(harness.alarms.length, 1);
    assert.equal(new Date(harness.alarms[0].when).toISOString(), '2026-01-01T00:05:00.000Z');

    await background.sleep(5 * 60 * 1000);
    await harness.browser.alarms.onAlarm.emit({ name: 'flow2apiSafetySync' });

    const updateCalls = harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].body.session_token, 'waiting-store-session');
}

async function main() {
    const tests = [
        testGlobalConfigConnectsWithoutOpeningConsole,
        testSyncUsesGlobalConfigAcrossStores,
        testPreviewUsesAdminTokenWithoutConsoleProbe,
        testConnectionTokenRecoveryUsesAdminTokenInsteadOfConsole,
        testGenericSyncErrorSchedulesQuickRetry,
        testMetadataUnknownSchedulesHourlyProbe,
        testScheduledAlarmOnlyRunsDueStore
    ];

    for (const run of tests) {
        await run();
    }

    console.log(`Smoke tests passed (${tests.length})`);
}

main().catch((error) => {
    console.error('FAIL', error);
    process.exitCode = 1;
});
