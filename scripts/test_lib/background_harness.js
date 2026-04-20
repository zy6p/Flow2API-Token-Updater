const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BACKGROUND_PATH = path.resolve(__dirname, '..', '..', 'background.js');
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
    const tabsOnUpdated = createEventEmitter();

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
            onUpdated: tabsOnUpdated,
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
                await tabsOnUpdated.emit(tabId, details, tab);
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

        if (requestUrl.pathname === '/api/login' && method === 'POST') {
            return createMockResponse(200, {
                success: true,
                token: 'admin-session-token'
            });
        }

        if (requestUrl.pathname === '/api/logout' && method === 'POST') {
            assert.equal(authHeader, 'Bearer admin-session-token', 'logout should use the temporary admin session');
            return createMockResponse(200, {
                success: true
            });
        }

        if (requestUrl.pathname === '/api/plugin/config' && method === 'GET') {
            assert.equal(authHeader, 'Bearer admin-session-token', 'config GET should use the temporary admin session');
            return createMockResponse(200, {
                config: {
                    connection_token: 'connection-token'
                }
            });
        }

        if (requestUrl.pathname === '/api/plugin/update-token' && method === 'POST') {
            assert.equal(authHeader, 'Bearer connection-token', 'update-token should use connection token');
            return createMockResponse(200, {
                success: true,
                action: 'updated',
                message: 'Token updated for user@example.com'
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

module.exports = {
    FLOW2API_ORIGIN,
    FLOW2API_MANAGE_URL,
    LABS_URL,
    SESSION_COOKIE_NAME,
    createHarness,
    loadBackground
};
