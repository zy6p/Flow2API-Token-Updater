#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BACKGROUND_PATH = path.resolve(__dirname, '..', 'background.js');
const FLOW2API_ORIGIN = 'http://mock-flow2api.local';
const FLOW2API_MANAGE_URL = `${FLOW2API_ORIGIN}/manage`;
const LABS_URL = 'https://labs.google/fx/vi/tools/flow';
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';

function createEventEmitter() {
    const listeners = new Set();

    return {
        addListener(listener) {
            listeners.add(listener);
        },
        removeListener(listener) {
            listeners.delete(listener);
        },
        async emit(...args) {
            for (const listener of listeners) {
                await listener(...args);
            }
        }
    };
}

function createStorageArea(initialState = {}) {
    const state = { ...initialState };

    return {
        async get(keys) {
            if (Array.isArray(keys)) {
                return Object.fromEntries(keys.map((key) => [key, state[key]]));
            }

            if (typeof keys === 'string') {
                return { [keys]: state[keys] };
            }

            if (keys && typeof keys === 'object') {
                const result = {};
                for (const [key, fallback] of Object.entries(keys)) {
                    result[key] = Object.prototype.hasOwnProperty.call(state, key)
                        ? state[key]
                        : fallback;
                }
                return result;
            }

            return { ...state };
        },
        async set(values) {
            Object.assign(state, values);
        },
        async remove(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) {
                delete state[key];
            }
        },
        dump() {
            return { ...state };
        }
    };
}

function createMockResponse(status, data) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);

    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return body;
        }
    };
}

function createHarness({
    cookies = [],
    tabs = [],
    syncState = {},
    onCreateTab = null,
    cookieStores = null,
    fetchHandler = null
} = {}) {
    const localStorageArea = createStorageArea();
    const syncStorageArea = createStorageArea(syncState);
    const apiCalls = [];
    const alarms = [];
    const notifications = [];
    const createdTabs = [...tabs];
    let nextTabId = createdTabs.reduce((maxId, tab) => Math.max(maxId, tab.id), 0) + 1;

    const browser = {
        runtime: {
            onInstalled: createEventEmitter(),
            onStartup: createEventEmitter(),
            onMessage: createEventEmitter(),
            async getBrowserInfo() {
                return { name: 'Firefox', version: '999.0' };
            }
        },
        cookies: {
            onChanged: createEventEmitter(),
            async getAllCookieStores() {
                const storeIds = Array.isArray(cookieStores) && cookieStores.length > 0
                    ? cookieStores.filter(Boolean)
                    : [...new Set(cookies.map((cookie) => cookie.storeId).filter(Boolean))];
                return storeIds.map((id) => ({ id }));
            },
            async getAll(details = {}) {
                return cookies.filter((cookie) => {
                    if (details.storeId && cookie.storeId !== details.storeId) {
                        return false;
                    }

                    if (details.name && cookie.name !== details.name) {
                        return false;
                    }

                    if (details.domain) {
                        const normalized = `${cookie.domain || ''}`.replace(/^\./, '');
                        if (normalized !== details.domain) {
                            return false;
                        }
                    }

                    if (details.url) {
                        try {
                            if (new URL(details.url).hostname !== `${cookie.domain || ''}`.replace(/^\./, '')) {
                                return false;
                            }
                        } catch (error) {
                            return false;
                        }
                    }

                    if (Object.prototype.hasOwnProperty.call(details, 'firstPartyDomain')) {
                        if ((cookie.firstPartyDomain || null) !== details.firstPartyDomain) {
                            return false;
                        }
                    }

                    if (details.partitionKey) {
                        const wanted = details.partitionKey.topLevelSite || null;
                        const actual = cookie.partitionKey?.topLevelSite || null;

                        if (wanted !== actual) {
                            return false;
                        }
                    }

                    return true;
                });
            }
        },
        alarms: {
            onAlarm: createEventEmitter(),
            async clear(name) {
                const index = alarms.findIndex((alarm) => alarm.name === name);
                if (index >= 0) {
                    alarms.splice(index, 1);
                }
            },
            create(name, details) {
                alarms.push({ name, ...details });
            }
        },
        storage: {
            local: localStorageArea,
            sync: syncStorageArea
        },
        permissions: {
            async contains(details) {
                return Array.isArray(details.origins)
                    && details.origins.includes(`${FLOW2API_ORIGIN}/*`);
            }
        },
        tabs: {
            async query(queryInfo = {}) {
                let result = [...createdTabs];

                if (queryInfo.active) {
                    result = result.filter((tab) => Boolean(tab.active));
                }

                if (queryInfo.currentWindow) {
                    result = result.filter((tab) => tab.windowId === 1);
                }

                return result;
            },
            async create(details) {
                const tab = {
                    id: nextTabId++,
                    windowId: 1,
                    status: 'complete',
                    cookieStoreId: details.url.startsWith('https://labs.google') ? 'default' : undefined,
                    ...details
                };

                if (typeof onCreateTab === 'function') {
                    Object.assign(tab, await onCreateTab(details, tab) || {});
                }

                createdTabs.push(tab);
                return tab;
            },
            async get(tabId) {
                const tab = createdTabs.find((item) => item.id === tabId);
                if (!tab) {
                    throw new Error(`Unknown tab ${tabId}`);
                }

                return tab;
            },
            async update(tabId, details) {
                const tab = createdTabs.find((item) => item.id === tabId);
                if (!tab) {
                    throw new Error(`Unknown tab ${tabId}`);
                }

                Object.assign(tab, details);
                return tab;
            },
            async remove(tabId) {
                const index = createdTabs.findIndex((item) => item.id === tabId);
                if (index >= 0) {
                    createdTabs.splice(index, 1);
                }
            }
        },
        windows: {
            async update() {
                return null;
            }
        },
        scripting: {
            async executeScript({ target }) {
                const tab = createdTabs.find((item) => item.id === target.tabId);
                if (!tab) {
                    throw new Error(`Unknown tab ${target.tabId}`);
                }

                return [{
                    result: {
                        href: tab.url,
                        origin: new URL(tab.url).origin,
                        pageKind: new URL(tab.url).pathname.startsWith('/manage') ? 'manage' : 'other',
                        adminToken: tab.mockAdminToken || ''
                    }
                }];
            }
        },
        notifications: {
            async create(details) {
                notifications.push(details);
                return 'notification';
            }
        }
    };

    async function fetch(url, options = {}) {
        const requestUrl = new URL(url);
        const method = (options.method || 'GET').toUpperCase();
        const authHeader = options.headers?.Authorization || '';
        const body = options.body ? JSON.parse(options.body) : null;

        apiCalls.push({
            method,
            url,
            authorization: authHeader,
            body
        });

        if (requestUrl.origin !== FLOW2API_ORIGIN) {
            throw new Error(`Unexpected fetch origin: ${requestUrl.origin}`);
        }

        if (typeof fetchHandler === 'function') {
            const override = await fetchHandler({
                url,
                options,
                requestUrl,
                method,
                authHeader,
                body,
                createMockResponse
            });

            if (override) {
                return override;
            }
        }

        if (requestUrl.pathname === '/api/plugin/config' && method === 'GET') {
            assert.equal(authHeader, 'Bearer admin-token', 'config GET should use admin token');
            return createMockResponse(200, {
                config: {
                    connection_token: 'connection-token'
                }
            });
        }

        if (requestUrl.pathname === '/api/plugin/config' && method === 'POST') {
            assert.equal(authHeader, 'Bearer admin-token', 'config POST should use admin token');
            return createMockResponse(200, {
                connection_token: 'connection-token'
            });
        }

        if (requestUrl.pathname === '/api/tokens/st2at' && method === 'POST') {
            assert.equal(authHeader, 'Bearer admin-token', 'st2at should use admin token');
            return createMockResponse(200, {
                success: true,
                email: 'user@example.com',
                expires: '2026-04-30T00:00:00.000Z'
            });
        }

        if (requestUrl.pathname === '/api/plugin/update-token' && method === 'POST') {
            assert.equal(authHeader, 'Bearer connection-token', 'update-token should use connection token');
            return createMockResponse(200, {
                success: true,
                action: 'updated',
                message: `Token updated for ${body.session_token}`
            });
        }

        return createMockResponse(404, {
            error: `No route for ${method} ${requestUrl.pathname}`
        });
    }

    return {
        browser,
        fetch,
        apiCalls,
        alarms,
        notifications,
        localStorageArea,
        syncStorageArea,
        createdTabs
    };
}

function loadBackground(harness) {
    const source = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    class FakeDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [nowMs]));
        }

        static now() {
            return nowMs;
        }
    }

    FakeDate.parse = Date.parse;
    FakeDate.UTC = Date.UTC;

    const context = {
        console,
        Date: FakeDate,
        URL,
        fetch: harness.fetch,
        setTimeout,
        clearTimeout,
        browser: harness.browser,
        chrome: undefined
    };
    context.globalThis = context;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: BACKGROUND_PATH });

    context.sleep = async (ms = 0) => {
        nowMs += ms;
        await new Promise((resolve) => setImmediate(resolve));
    };

    return context;
}

async function testConnectionSucceedsWithoutLabsSession() {
    const harness = createHarness({
        tabs: [{
            id: 1,
            windowId: 1,
            active: true,
            status: 'complete',
            url: FLOW2API_MANAGE_URL,
            mockAdminToken: 'admin-token'
        }]
    });

    const background = loadBackground(harness);
    const result = await background.connectBaseUrl(FLOW2API_ORIGIN);

    assert.equal(result.success, true);
    assert.equal(result.hasConnection, true);
    assert.equal(result.synced, false);
    assert.match(result.message, /Google Labs/);
    assert.equal(result.lastSync.status, 'waiting_session');

    const stored = harness.localStorageArea.dump();
    assert.equal(stored.configByStore.__default__.baseUrl, FLOW2API_ORIGIN);
    assert.equal(stored.configByStore.__default__.connectionToken, 'connection-token');
    assert.equal(stored.lastSync.status, 'waiting_session');
    assert.deepEqual(harness.syncStorageArea.dump(), {});
    const updateCalls = harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.equal(updateCalls.length, 0, 'should not push session when Labs cookie is missing');
}

async function testSyncFindsCookieOutsideDefaultStore() {
    const harness = createHarness({
        tabs: [
            {
                id: 1,
                windowId: 1,
                active: true,
                status: 'complete',
                url: FLOW2API_MANAGE_URL,
                mockAdminToken: 'admin-token'
            },
            {
                id: 2,
                windowId: 1,
                active: false,
                status: 'complete',
                url: LABS_URL,
                cookieStoreId: 'firefox-container-7'
            }
        ],
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'labs-session-token',
            domain: 'labs.google',
            path: '/',
            storeId: 'firefox-container-7',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }]
    });

    const background = loadBackground(harness);
    const result = await background.connectBaseUrl(FLOW2API_ORIGIN);

    assert.equal(result.success, true);
    assert.equal(result.hasConnection, true);
    assert.equal(result.synced, true);
    assert.equal(result.lastSync.status, 'success');
    assert.equal(result.lastSync.email, 'user@example.com');
    assert.match(result.message, /Token updated for labs-session-token/);

    const updateCall = harness.apiCalls.find((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.ok(updateCall, 'should call update-token when Labs cookie exists');
    assert.equal(updateCall.body.session_token, 'labs-session-token');
    assert.equal(updateCall.authorization, 'Bearer connection-token');
    assert.equal(harness.alarms.length, 1, 'should schedule exactly one safety sync');
    assert.equal(
        new Date(harness.alarms[0].when).toISOString(),
        '2026-01-01T12:00:00.000Z',
        'should schedule by access-token expiry when it is earlier than the Labs cookie expiry'
    );
    assert.deepEqual(harness.syncStorageArea.dump(), {});
}


async function testStoreScopedSetupDataStaysSeparated() {
    const harness = createHarness({
        onCreateTab(details) {
            if (details.url === FLOW2API_MANAGE_URL) {
                return {
                    mockAdminToken: 'admin-token'
                };
            }

            return null;
        },
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
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'connection-token'
    });

    const store1Result = await background.handleMessage({
        action: 'syncNow',
        cookieStoreId: 'firefox-container-1'
    });
    const store3Result = await background.handleMessage({
        action: 'syncNow',
        cookieStoreId: 'firefox-container-3'
    });

    assert.equal(store1Result.success, true);
    assert.equal(store3Result.success, true);

    const store1Setup = await background.handleMessage({
        action: 'getSetupData',
        cookieStoreId: 'firefox-container-1'
    });
    const store3Setup = await background.handleMessage({
        action: 'getSetupData',
        cookieStoreId: 'firefox-container-3'
    });

    assert.equal(store1Setup.success, true);
    assert.equal(store3Setup.success, true);
    assert.equal(store1Setup.settings.lastSync.email, 'store-1-session@example.com');
    assert.equal(store3Setup.settings.lastSync.email, 'store-3-session@example.com');
    assert.equal(store1Setup.settings.lastSync.email === store3Setup.settings.lastSync.email, false);

    const stored = harness.localStorageArea.dump();
    assert.equal(stored.lastSyncByStore['firefox-container-1'].email, 'store-1-session@example.com');
    assert.equal(stored.lastSyncByStore['firefox-container-3'].email, 'store-3-session@example.com');
}

async function testStoreScopedConnectionConfigStaysSeparated() {
    const harness = createHarness({
        tabs: [
            {
                id: 1,
                windowId: 1,
                active: true,
                status: 'complete',
                url: FLOW2API_MANAGE_URL,
                cookieStoreId: 'firefox-container-1',
                mockAdminToken: 'admin-store-1'
            },
            {
                id: 2,
                windowId: 1,
                active: false,
                status: 'complete',
                url: FLOW2API_MANAGE_URL,
                cookieStoreId: 'firefox-container-3',
                mockAdminToken: 'admin-store-3'
            }
        ],
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
            if (requestUrl.pathname === '/api/plugin/config' && method === 'GET') {
                if (authHeader === 'Bearer admin-store-1') {
                    return createMockResponse(200, {
                        config: {
                            connection_token: 'connection-token-store-1'
                        }
                    });
                }

                if (authHeader === 'Bearer admin-store-3') {
                    return createMockResponse(200, {
                        config: {
                            connection_token: 'connection-token-store-3'
                        }
                    });
                }
            }

            if (requestUrl.pathname === '/api/tokens/st2at' && method === 'POST') {
                if (authHeader === 'Bearer admin-store-1' || authHeader === 'Bearer admin-store-3') {
                    return createMockResponse(200, {
                        success: true,
                        email: `${body.st}@example.com`,
                        expires: '2026-04-30T00:00:00.000Z'
                    });
                }
            }

            if (requestUrl.pathname === '/api/plugin/update-token' && method === 'POST') {
                if (authHeader === 'Bearer connection-token-store-1' || authHeader === 'Bearer connection-token-store-3') {
                    return createMockResponse(200, {
                        success: true,
                        action: 'updated',
                        message: `Token updated for ${body.session_token}`
                    });
                }
            }

            return null;
        }
    });

    const background = loadBackground(harness);

    const store1Result = await background.handleMessage({
        action: 'connectBaseUrl',
        baseUrl: FLOW2API_ORIGIN,
        cookieStoreId: 'firefox-container-1'
    });
    const store3Result = await background.handleMessage({
        action: 'connectBaseUrl',
        baseUrl: FLOW2API_ORIGIN,
        cookieStoreId: 'firefox-container-3'
    });

    assert.equal(store1Result.success, true);
    assert.equal(store3Result.success, true);

    const store1Setup = await background.handleMessage({
        action: 'getSetupData',
        cookieStoreId: 'firefox-container-1'
    });
    const store3Setup = await background.handleMessage({
        action: 'getSetupData',
        cookieStoreId: 'firefox-container-3'
    });

    assert.equal(store1Setup.settings.connectionToken, 'connection-token-store-1');
    assert.equal(store3Setup.settings.connectionToken, 'connection-token-store-3');

    const stored = harness.localStorageArea.dump();
    assert.equal(stored.configByStore['firefox-container-1'].connectionToken, 'connection-token-store-1');
    assert.equal(stored.configByStore['firefox-container-3'].connectionToken, 'connection-token-store-3');

    const updateCalls = harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.equal(updateCalls.length, 2);
    assert.deepEqual(
        updateCalls.map((call) => [call.body.session_token, call.authorization]),
        [
            ['store-1-session', 'Bearer connection-token-store-1'],
            ['store-3-session', 'Bearer connection-token-store-3']
        ]
    );
}

async function testSetupDataPrefersCurrentSessionHistoryOverStaleStoreRecord() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'profile-b-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }]
    });

    const background = loadBackground(harness);
    const staleFingerprint = background.fingerprintSessionToken('profile-a-session');
    const currentFingerprint = background.fingerprintSessionToken('profile-b-session');

    await harness.localStorageArea.set({
        configByStore: {
            default: {
                baseUrl: FLOW2API_ORIGIN,
                connectionToken: 'connection-token'
            }
        },
        lastSyncByStore: {
            default: {
                status: 'success',
                reason: 'manual_sync',
                syncedAt: '2026-01-01T00:00:00.000Z',
                email: 'profile-a@example.com',
                atExpires: '2026-04-30T00:00:00.000Z',
                sessionExpiresAt: '2026-11-30T16:00:00.000Z',
                sessionFingerprint: staleFingerprint,
                action: 'updated',
                message: '同步成功'
            }
        },
        lastSyncBySession: {
            [staleFingerprint]: {
                status: 'success',
                reason: 'manual_sync',
                syncedAt: '2026-01-01T00:00:00.000Z',
                email: 'profile-a@example.com',
                atExpires: '2026-04-30T00:00:00.000Z',
                sessionExpiresAt: '2026-11-30T16:00:00.000Z',
                sessionFingerprint: staleFingerprint,
                action: 'updated',
                message: '同步成功'
            },
            [currentFingerprint]: {
                status: 'success',
                reason: 'manual_sync',
                syncedAt: '2026-01-02T00:00:00.000Z',
                email: 'profile-b@example.com',
                atExpires: '2026-05-01T00:00:00.000Z',
                sessionExpiresAt: '2026-11-30T16:00:00.000Z',
                sessionFingerprint: currentFingerprint,
                action: 'updated',
                message: '同步成功'
            }
        }
    });

    const setup = await background.getSetupData('default');
    assert.equal(setup.success, true);
    assert.equal(setup.settings.lastSync.email, 'profile-b@example.com');
    assert.equal(setup.settings.lastSync.sessionFingerprint, currentFingerprint);
}

async function testSetupDataDetectsUnsyncedCurrentSessionInsteadOfShowingStaleAccount() {
    const harness = createHarness({
        tabs: [{
            id: 1,
            windowId: 1,
            active: true,
            status: 'complete',
            url: FLOW2API_MANAGE_URL,
            cookieStoreId: 'default',
            mockAdminToken: 'admin-token'
        }],
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'profile-b-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }],
        fetchHandler({ requestUrl, method, authHeader, body, createMockResponse }) {
            if (requestUrl.pathname === '/api/tokens/st2at' && method === 'POST' && authHeader === 'Bearer admin-token') {
                return createMockResponse(200, {
                    success: true,
                    email: body.st === 'profile-b-session' ? 'profile-b@example.com' : 'profile-a@example.com',
                    expires: '2026-05-01T00:00:00.000Z'
                });
            }

            return null;
        }
    });

    const background = loadBackground(harness);
    const staleFingerprint = background.fingerprintSessionToken('profile-a-session');

    await harness.localStorageArea.set({
        configByStore: {
            default: {
                baseUrl: FLOW2API_ORIGIN,
                connectionToken: 'connection-token'
            }
        },
        lastSyncByStore: {
            default: {
                status: 'success',
                reason: 'manual_sync',
                syncedAt: '2026-01-01T00:00:00.000Z',
                email: 'profile-a@example.com',
                atExpires: '2026-04-30T00:00:00.000Z',
                sessionExpiresAt: '2026-11-30T16:00:00.000Z',
                sessionFingerprint: staleFingerprint,
                action: 'updated',
                message: '同步成功'
            }
        },
        lastSyncBySession: {
            [staleFingerprint]: {
                status: 'success',
                reason: 'manual_sync',
                syncedAt: '2026-01-01T00:00:00.000Z',
                email: 'profile-a@example.com',
                atExpires: '2026-04-30T00:00:00.000Z',
                sessionExpiresAt: '2026-11-30T16:00:00.000Z',
                sessionFingerprint: staleFingerprint,
                action: 'updated',
                message: '同步成功'
            }
        }
    });

    const setup = await background.getSetupData('default');
    assert.equal(setup.success, true);
    assert.equal(setup.settings.lastSync.status, 'detected_session');
    assert.equal(setup.settings.lastSync.email, 'profile-b@example.com');
    assert.equal(setup.settings.lastSync.email === 'profile-a@example.com', false);
}

async function testFreshProfileIgnoresLegacySharedConfig() {
    const harness = createHarness({
        syncState: {
            sharedBaseUrl: FLOW2API_ORIGIN,
            sharedConnectionToken: 'connection-token',
            apiUrl: FLOW2API_ORIGIN,
            connectionToken: 'legacy-sync-token'
        }
    });

    const background = loadBackground(harness);
    const setup = await background.getSetupData();

    assert.equal(setup.settings.baseUrl, '');
    assert.equal(setup.settings.connectionToken, '');
    assert.equal(setup.settings.configSource, 'none');
    assert.equal(setup.hasConnection, false);

    const result = await background.syncCurrentSession({
        reason: 'manual_sync',
        allowLabsWakeup: false,
        notifyOnError: false
    });

    assert.equal(result.success, false);
    assert.match(result.error, /Flow2API 地址/);
}

async function testPerProfileConfigFallsBackToSixHourSafetySyncWithoutAdminSession() {
    const harness = createHarness({
        tabs: [{
            id: 2,
            windowId: 1,
            active: false,
            status: 'complete',
            url: LABS_URL,
            cookieStoreId: 'firefox-container-10'
        }],
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'local-profile-session-no-admin',
            domain: 'labs.google',
            path: '/',
            storeId: 'firefox-container-10',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }]
    });

    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'connection-token'
    });

    const result = await background.syncCurrentSession({
        reason: 'manual_sync',
        allowLabsWakeup: false,
        notifyOnError: false
    });

    assert.equal(result.success, true);
    assert.equal(result.lastSync.status, 'success');
    assert.equal(result.lastSync.atExpires, null);
    assert.equal(harness.alarms.length, 1);
    assert.equal(
        new Date(harness.alarms[0].when).toISOString(),
        '2026-01-01T06:00:00.000Z',
        'should cap safety sync to six hours when account expiry metadata is unavailable'
    );
}

async function testKnownConnectionCanSilentlyWakeConsoleForExpiryMetadata() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'known-connection-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }],
        onCreateTab(details) {
            if (details.url === FLOW2API_MANAGE_URL) {
                return {
                    mockAdminToken: 'admin-token'
                };
            }

            return null;
        }
    });

    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'connection-token'
    });

    const result = await background.syncCurrentSession({
        reason: 'scheduled_check',
        allowLabsWakeup: false,
        allowConsoleWakeup: true,
        notifyOnError: false
    });

    assert.equal(result.success, true);
    assert.equal(result.lastSync.status, 'success');
    assert.equal(result.lastSync.email, 'user@example.com');
    assert.equal(result.lastSync.atExpires, '2026-04-30T00:00:00.000Z');
    assert.equal(harness.alarms.length, 1);
    assert.equal(
        new Date(harness.alarms[0].when).toISOString(),
        '2026-01-01T12:00:00.000Z',
        'should silently wake Flow2API console to recover precise expiry metadata'
    );
    assert.equal(
        harness.createdTabs.filter((tab) => tab.url === FLOW2API_MANAGE_URL).length,
        0,
        'temporary Flow2API console tabs should be closed after metadata discovery'
    );
}


async function testPreferredSessionContextCanWakeSpecificStore() {
    const cookies = [];
    const harness = createHarness({
        cookies,
        onCreateTab(details) {
            if (details.url === LABS_URL && details.cookieStoreId === 'firefox-container-42') {
                cookies.push({
                    name: SESSION_COOKIE_NAME,
                    value: 'preferred-store-session',
                    domain: 'labs.google',
                    path: '/',
                    storeId: 'firefox-container-42',
                    firstPartyDomain: null,
                    expirationDate: 1796054400
                });
            }

            return null;
        }
    });

    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'connection-token',
        sessionContext: {
            storeId: 'firefox-container-42',
            firstPartyDomain: null,
            partitionTopLevelSite: null,
            domain: 'labs.google',
            path: '/',
            name: SESSION_COOKIE_NAME
        }
    });

    const result = await background.syncCurrentSession({
        reason: 'scheduled_check',
        allowLabsWakeup: true,
        allowConsoleWakeup: false,
        notifyOnError: false
    });

    assert.equal(result.success, true);
    const updateCall = harness.apiCalls.find((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.ok(updateCall, 'preferred session store wakeup should eventually push the recovered Labs token');
    assert.equal(updateCall.body.session_token, 'preferred-store-session');
}

async function testInvalidStaleCookieTriggersWakeupAndFallbackToFreshSession() {
    const cookies = [{
        name: SESSION_COOKIE_NAME,
        value: 'stale-session-token',
        domain: 'labs.google',
        path: '/',
        storeId: 'default',
        firstPartyDomain: null,
        expirationDate: 1797000000
    }];

    const harness = createHarness({
        cookies,
        onCreateTab(details) {
            if (details.url === FLOW2API_MANAGE_URL) {
                return {
                    mockAdminToken: 'admin-token'
                };
            }

            if (details.url === LABS_URL) {
                cookies.push({
                    name: SESSION_COOKIE_NAME,
                    value: 'fresh-session-token',
                    domain: 'labs.google',
                    path: '/',
                    storeId: details.cookieStoreId || 'default',
                    firstPartyDomain: null,
                    expirationDate: 1796054400
                });
            }

            return null;
        },
        fetchHandler({ requestUrl, method, authHeader, body, createMockResponse }) {
            if (requestUrl.pathname === '/api/tokens/st2at' && method === 'POST' && authHeader === 'Bearer admin-token') {
                if (body.st === 'stale-session-token') {
                    return createMockResponse(401, {
                        message: 'session token expired'
                    });
                }

                if (body.st === 'fresh-session-token') {
                    return createMockResponse(200, {
                        success: true,
                        email: 'fresh@example.com',
                        expires: '2026-04-30T00:00:00.000Z'
                    });
                }
            }

            return null;
        }
    });

    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'connection-token'
    });

    const result = await background.syncCurrentSession({
        reason: 'scheduled_check',
        allowLabsWakeup: true,
        allowConsoleWakeup: true,
        notifyOnError: false
    });

    assert.equal(result.success, true);
    assert.equal(result.lastSync.email, 'fresh@example.com');

    const updateCalls = harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.equal(updateCalls.length, 1, 'only the fresh session token should be pushed');
    assert.equal(updateCalls[0].body.session_token, 'fresh-session-token');
}

async function testKeepsExistingTokenWhenCookieCannotBeValidated() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'unverified-session-token',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1797000000
        }]
    });

    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'connection-token',
        lastSyncByStore: {
            __default__: {
                status: 'success',
                reason: 'scheduled_check',
                syncedAt: '2026-01-01T00:00:00.000Z',
                email: 'known@example.com',
                atExpires: '2026-01-01T08:00:00.000Z',
                sessionExpiresAt: '2026-11-30T16:00:00.000Z',
                action: 'updated',
                message: '同步成功'
            }
        }
    });

    const result = await background.syncCurrentSession({
        reason: 'scheduled_check',
        allowLabsWakeup: true,
        allowConsoleWakeup: true,
        notifyOnError: false
    });

    assert.equal(result.success, false);
    assert.equal(result.lastSync.status, 'waiting_session');
    assert.match(result.lastSync.message, /保留现有 token/);

    const updateCalls = harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.equal(updateCalls.length, 0, 'unverified cookies should not overwrite an existing valid token');
}

async function testStaleConnectionTokenCanRecoverFromConsole() {
    const harness = createHarness({
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'stale-connection-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'default',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }],
        onCreateTab(details) {
            if (details.url === FLOW2API_MANAGE_URL) {
                return {
                    mockAdminToken: 'admin-token'
                };
            }

            return null;
        },
        fetchHandler({ requestUrl, method, authHeader, createMockResponse }) {
            if (requestUrl.pathname === '/api/plugin/update-token' && method === 'POST' && authHeader === 'Bearer stale-connection-token') {
                return createMockResponse(401, {
                    message: 'invalid connection token'
                });
            }

            return null;
        }
    });

    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'stale-connection-token'
    });

    const result = await background.syncCurrentSession({
        reason: 'scheduled_check',
        allowLabsWakeup: false,
        allowConsoleWakeup: true,
        notifyOnError: false
    });

    assert.equal(result.success, true);
    const stored = harness.localStorageArea.dump();
    assert.equal(stored.configByStore.default.connectionToken, 'connection-token');

    const updateCalls = harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.equal(updateCalls.length, 2, 'stale connection tokens should be retried once after console hydration');
    assert.equal(updateCalls[0].authorization, 'Bearer stale-connection-token');
    assert.equal(updateCalls[1].authorization, 'Bearer connection-token');
}


async function testUnrelatedCookieRemovalDoesNotHijackPreferredSessionContext() {
    const harness = createHarness();
    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'connection-token',
        lastSync: {
            status: 'success',
            syncedAt: '2026-04-01T00:00:00.000Z',
            email: 'preferred@example.com',
            message: '同步成功'
        },
        sessionContext: {
            storeId: 'firefox-container-42',
            firstPartyDomain: null,
            partitionTopLevelSite: null,
            domain: 'labs.google',
            path: '/',
            name: SESSION_COOKIE_NAME
        }
    });

    await harness.browser.cookies.onChanged.emit({
        removed: true,
        cause: 'expired',
        cookie: {
            name: SESSION_COOKIE_NAME,
            domain: 'labs.google',
            storeId: 'firefox-container-99',
            path: '/'
        }
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.apiCalls.filter((call) => call.url.endsWith('/api/plugin/update-token')).length, 0);
    const stored = harness.localStorageArea.dump();
    assert.equal(stored.lastSync.email, 'preferred@example.com');
    assert.equal(harness.notifications.length, 0);
}

async function testStartupCanSilentlyHydrateAndSync() {
    const cookies = [];
    const labsCookie = {
        name: SESSION_COOKIE_NAME,
        value: 'auto-labs-session',
        domain: 'labs.google',
        path: '/',
        storeId: 'default',
        firstPartyDomain: null,
        expirationDate: 1796054400
    };

    const harness = createHarness({
        cookies,
        onCreateTab(details) {
            if (details.url === FLOW2API_MANAGE_URL) {
                return {
                    mockAdminToken: 'admin-token'
                };
            }

            if (details.url === LABS_URL) {
                cookies.push(labsCookie);
            }

            return null;
        }
    });

    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN
    });

    await harness.browser.runtime.onStartup.emit();

    const stored = harness.localStorageArea.dump();
    assert.equal(stored.configByStore.__default__.connectionToken, 'connection-token');
    assert.equal(stored.lastSync.status, 'success');
    assert.equal(stored.lastSync.reason, 'startup');

    const updateCall = harness.apiCalls.find((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.ok(updateCall, 'startup should silently sync when existing sessions can be discovered');
    assert.equal(updateCall.body.session_token, 'auto-labs-session');
    assert.equal(
        harness.createdTabs.filter((tab) => tab.url === FLOW2API_MANAGE_URL || tab.url === LABS_URL).length,
        0,
        'temporary discovery tabs should be closed after a successful silent sync'
    );
}

async function testCookieRemovalTriggersSilentRecovery() {
    const cookies = [];
    const harness = createHarness({
        cookies,
        onCreateTab(details) {
            if (details.url === LABS_URL) {
                cookies.push({
                    name: SESSION_COOKIE_NAME,
                    value: 'recovered-after-expiry',
                    domain: 'labs.google',
                    path: '/',
                    storeId: 'default',
                    firstPartyDomain: null,
                    expirationDate: 1796054400
                });
            }

            return null;
        }
    });

    const background = loadBackground(harness);
    await harness.localStorageArea.set({
        baseUrl: FLOW2API_ORIGIN,
        connectionToken: 'connection-token',
        lastSync: {
            status: 'success',
            syncedAt: '2026-04-01T00:00:00.000Z',
            email: 'known@example.com',
            sessionExpiresAt: '2026-04-02T00:00:00.000Z',
            message: '同步成功'
        }
    });

    await harness.browser.cookies.onChanged.emit({
        removed: true,
        cause: 'expired',
        cookie: {
            name: SESSION_COOKIE_NAME,
            domain: 'labs.google'
        }
    });

    let stored = harness.localStorageArea.dump();
    for (let attempt = 0; attempt < 50; attempt += 1) {
        stored = harness.localStorageArea.dump();
        if (stored.lastSync?.reason === 'cookie_removed_recovery') {
            break;
        }

        await new Promise((resolve) => setImmediate(resolve));
    }

    stored = harness.localStorageArea.dump();
    assert.equal(stored.lastSync.status, 'success');
    assert.equal(stored.lastSync.reason, 'cookie_removed_recovery');
    assert.equal(stored.lastSync.email, 'known@example.com');
    assert.equal(harness.notifications.length, 0, 'successful silent recovery should not notify the user');
    assert.equal(
        harness.createdTabs.filter((tab) => tab.url === LABS_URL).length,
        0,
        'temporary Labs recovery tabs should be closed after silent recovery'
    );

    const updateCall = harness.apiCalls.find((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.ok(updateCall, 'cookie expiry recovery should push the refreshed Labs token');
    assert.equal(updateCall.body.session_token, 'recovered-after-expiry');
}

async function main() {
    const tests = [
        ['connects Flow2API even when Labs session is missing', testConnectionSucceedsWithoutLabsSession],
        ['syncs using a Labs cookie found in a non-default Firefox store', testSyncFindsCookieOutsideDefaultStore],
        ['keeps setup data isolated per Firefox cookie store', testStoreScopedSetupDataStaysSeparated],
        ['keeps Flow2API connection config isolated per Firefox cookie store', testStoreScopedConnectionConfigStaysSeparated],
        ['prefers the current Labs session history over a stale shared store record', testSetupDataPrefersCurrentSessionHistoryOverStaleStoreRecord],
        ['detects an unsynced current Labs session instead of showing a stale account', testSetupDataDetectsUnsyncedCurrentSessionInsteadOfShowingStaleAccount],
        ['ignores legacy shared config when a fresh profile starts', testFreshProfileIgnoresLegacySharedConfig],
        ['caps safety sync to six hours when admin expiry metadata is unavailable', testPerProfileConfigFallsBackToSixHourSafetySyncWithoutAdminSession],
        ['silently wakes Flow2API console to recover expiry metadata for known connections', testKnownConnectionCanSilentlyWakeConsoleForExpiryMetadata],
        ['wakes the previously successful Labs cookie store before falling back to other stores', testPreferredSessionContextCanWakeSpecificStore],
        ['ignores stale Labs cookies and wakes a fresh session before syncing', testInvalidStaleCookieTriggersWakeupAndFallbackToFreshSession],
        ['preserves the current token when a Labs cookie cannot be validated yet', testKeepsExistingTokenWhenCookieCannotBeValidated],
        ['recovers from a stale Flow2API connection token by rehydrating from the console', testStaleConnectionTokenCanRecoverFromConsole],
        ['ignores Labs cookie removals that do not belong to the preferred session context', testUnrelatedCookieRemovalDoesNotHijackPreferredSessionContext],
        ['silently hydrates Flow2API and Labs sessions during startup', testStartupCanSilentlyHydrateAndSync],
        ['silently recovers after Labs session expiry when browser login still exists', testCookieRemovalTriggersSilentRecovery]
    ];

    for (const [label, test] of tests) {
        await test();
        console.log(`PASS ${label}`);
    }

    console.log(`PASS ${tests.length} smoke checks`);
}

main().catch((error) => {
    console.error(`FAIL ${error.stack || error.message}`);
    process.exitCode = 1;
});
