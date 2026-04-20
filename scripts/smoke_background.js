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
    connectionToken = 'connection-token',
    storePolicyByStore = {}
} = {}) {
    return {
        globalFlow2ApiConfig: {
            baseUrl,
            connectionToken
        },
        storePolicyByStore
    };
}

async function testGlobalConfigConnectsWithoutOpeningConsole() {
    const harness = createHarness();
    const background = loadBackground(harness);

    const result = await background.connectBaseUrl(FLOW2API_ORIGIN, 'connection-token');

    assert.equal(result.success, true);
    assert.equal(result.hasConnection, true);
    assert.equal(result.hasConnectionToken, true);
    assert.equal(result.synced, false);
    assert.equal(result.lastSync.status, 'waiting_session');

    const stored = harness.localStorageArea.dump();
    assert.equal(stored.globalFlow2ApiConfig.baseUrl, FLOW2API_ORIGIN);
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
            if (requestUrl.pathname === '/api/plugin/update-token' && method === 'POST' && authHeader === 'Bearer connection-token') {
                return createMockResponse(200, {
                    success: true,
                    action: 'updated',
                    message: body.session_token === 'store-1-session'
                        ? 'Token updated for store-1@example.com'
                        : 'Token updated for store-3@example.com'
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
    assert.equal(stored.lastSyncByStore['firefox-container-1'].email, 'store-1@example.com');
    assert.equal(stored.lastSyncByStore['firefox-container-3'].email, 'store-3@example.com');

    const updateCalls = harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.deepEqual(
        updateCalls.map((call) => [call.body.session_token, call.authorization]),
        [
            ['store-1-session', 'Bearer connection-token'],
            ['store-3-session', 'Bearer connection-token']
        ]
    );
}

async function testPreviewUsesConnectionTokenWithoutConsoleProbe() {
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
    assert.equal(setup.hasConnectionToken, true);
    assert.equal(setup.settings.lastSync.status, 'detected_session');
    assert.equal(setup.settings.lastSync.email, null);
    assert.equal(
        harness.createdTabs.filter((tab) => tab.url === FLOW2API_MANAGE_URL).length,
        0,
        'metadata preview should not create Flow2API manage tabs'
    );
    assert.equal(
        harness.apiCalls.some((call) => call.url.endsWith('/api/tokens/st2at')),
        false,
        'preview should no longer depend on privileged st2at lookups'
    );
}

async function testBootstrapConnectionTokenUsesTemporaryAdminLogin() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'bootstrap-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }]
    });
    const background = loadBackground(harness);

    const result = await background.bootstrapConnectionToken({
        baseUrl: FLOW2API_ORIGIN,
        username: 'admin',
        password: 'secret',
        cookieStoreId: 'default'
    });

    assert.equal(result.success, true);
    assert.equal(result.lastSync.status, 'success');
    assert.equal(harness.localStorageArea.dump().globalFlow2ApiConfig.connectionToken, 'connection-token');
    assert.equal(harness.localStorageArea.dump().globalFlow2ApiConfig.adminToken, '');
    assert.equal(
        harness.apiCalls.some((call) => call.url.endsWith('/api/login')),
        true,
        'bootstrap should use the backend login endpoint exactly once'
    );
    assert.equal(
        harness.apiCalls.some((call) => call.url.endsWith('/api/logout')),
        true,
        'bootstrap should clean up the temporary admin session'
    );
    assert.equal(
        harness.createdTabs.filter((tab) => tab.url === FLOW2API_MANAGE_URL).length,
        0,
        'bootstrap should stay on the API path'
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
    await harness.localStorageArea.set({
        storePolicyByStore: {
            __default__: 'auto'
        }
    });

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
        connectionToken: 'connection-token',
        storePolicyByStore: {
            __default__: 'auto'
        }
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

async function testObserveStoreDoesNotJoinAutomaticScheduling() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'observe-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'firefox-container-9',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }]
    });
    const background = loadBackground(harness);

    await harness.localStorageArea.set({
        ...buildGlobalConfig(),
        storePolicyByStore: {
            'firefox-container-9': 'observe'
        }
    });

    const result = await background.syncCurrentSession({
        reason: 'manual_sync',
        allowLabsWakeup: false,
        allowConsoleWakeup: false,
        notifyOnError: false,
        cookieStoreId: 'firefox-container-9'
    });

    assert.equal(result.success, true);
    assert.equal(result.lastSync.status, 'success');

    await background.refreshSafetyAlarm();
    assert.equal(harness.alarms.length, 0, 'observe stores should not create proactive alarms');
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
        storePolicyByStore: {
            'firefox-container-1': 'auto',
            'firefox-container-2': 'auto'
        },
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
        },
        sessionContextByStore: {
            'firefox-container-2': {
                storeId: 'firefox-container-2',
                domain: 'labs.google',
                path: '/',
                name: SESSION_COOKIE_NAME
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
        testPreviewUsesConnectionTokenWithoutConsoleProbe,
        testBootstrapConnectionTokenUsesTemporaryAdminLogin,
        testGenericSyncErrorSchedulesQuickRetry,
        testMetadataUnknownSchedulesHourlyProbe,
        testObserveStoreDoesNotJoinAutomaticScheduling,
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
