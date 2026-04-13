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
    syncState = {}
} = {}) {
    const localStorageArea = createStorageArea();
    const syncStorageArea = createStorageArea(syncState);
    const apiCalls = [];
    const alarms = [];
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
                const storeIds = [...new Set(cookies.map((cookie) => cookie.storeId).filter(Boolean))];
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
            async create() {
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
        localStorageArea,
        syncStorageArea,
        createdTabs
    };
}

function loadBackground(harness) {
    const source = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    const context = {
        console,
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

    context.sleep = async () => {};

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
    assert.equal(stored.baseUrl, FLOW2API_ORIGIN);
    assert.equal(stored.connectionToken, 'connection-token');
    assert.equal(stored.lastSync.status, 'waiting_session');
    const shared = harness.syncStorageArea.dump();
    assert.equal(shared.sharedBaseUrl, FLOW2API_ORIGIN);
    assert.equal(shared.sharedConnectionToken, 'connection-token');

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
    const shared = harness.syncStorageArea.dump();
    assert.equal(shared.sharedBaseUrl, FLOW2API_ORIGIN);
    assert.equal(shared.sharedConnectionToken, 'connection-token');
}

async function testSharedConfigCanBootstrapAnotherProfile() {
    const harness = createHarness({
        tabs: [{
            id: 2,
            windowId: 1,
            active: false,
            status: 'complete',
            url: LABS_URL,
            cookieStoreId: 'firefox-container-9'
        }],
        cookies: [{
            name: SESSION_COOKIE_NAME,
            value: 'shared-profile-session',
            domain: 'labs.google',
            path: '/',
            storeId: 'firefox-container-9',
            firstPartyDomain: null,
            expirationDate: 1796054400
        }],
        syncState: {
            sharedBaseUrl: FLOW2API_ORIGIN,
            sharedConnectionToken: 'connection-token'
        }
    });

    const background = loadBackground(harness);
    const setup = await background.getSetupData();

    assert.equal(setup.settings.baseUrl, FLOW2API_ORIGIN);
    assert.equal(setup.settings.connectionToken, 'connection-token');
    assert.equal(setup.settings.configSource, 'sync');
    assert.equal(setup.hasConnection, true);

    const result = await background.syncCurrentSession({
        reason: 'manual_sync',
        allowLabsWakeup: false,
        notifyOnError: false
    });

    assert.equal(result.success, true);
    assert.equal(result.lastSync.status, 'success');

    const updateCall = harness.apiCalls.find((call) => call.url.endsWith('/api/plugin/update-token'));
    assert.ok(updateCall, 'shared config should allow syncing without reconnecting Flow2API');
    assert.equal(updateCall.body.session_token, 'shared-profile-session');
}

async function main() {
    const tests = [
        ['connects Flow2API even when Labs session is missing', testConnectionSucceedsWithoutLabsSession],
        ['syncs using a Labs cookie found in a non-default Firefox store', testSyncFindsCookieOutsideDefaultStore],
        ['bootstraps another profile from shared Flow2API config', testSharedConfigCanBootstrapAnotherProfile]
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
