const extensionApi = globalThis.browser ?? globalThis.chrome;

const LABS_URL = 'https://labs.google/fx/vi/tools/flow';
const LABS_COOKIE_URL = 'https://labs.google/';
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const WAITING_FOR_LABS_MESSAGE = 'Flow2API 已接入。登录当前 Profile 的 Google Labs 后，扩展会自动完成同步。';
const ACCOUNT_SECRETS_KEY = 'accountSecrets';
const SHARED_BASE_URL_KEY = 'sharedBaseUrl';
const SHARED_CONNECTION_TOKEN_KEY = 'sharedConnectionToken';
const SYNC_ALARM_NAME = 'flow2apiSafetySync';
const DEFAULT_SAFETY_SYNC_MINUTES = 360;
const EARLY_REFRESH_MS = 30 * 60 * 1000;
const TAB_LOAD_TIMEOUT_MS = 20000;
const SESSION_WAIT_MS = 3000;

const runtimeState = {
    activeSync: null
};

const Logger = {
    async log(level, message, details = null) {
        const timestamp = new Date().toISOString();
        const entry = { timestamp, level, message, details };

        console.log(`[${level}] ${message}`, details || '');

        const { logs = [] } = await extensionApi.storage.local.get(['logs']);
        logs.unshift(entry);

        if (logs.length > 120) {
            logs.splice(120);
        }

        await extensionApi.storage.local.set({ logs });
    },

    info(message, details) {
        return this.log('INFO', message, details);
    },

    success(message, details) {
        return this.log('SUCCESS', message, details);
    },

    error(message, details) {
        return this.log('ERROR', message, details);
    },

    async getLogs() {
        const { logs = [] } = await extensionApi.storage.local.get(['logs']);
        return logs;
    },

    async clearLogs() {
        await extensionApi.storage.local.set({ logs: [] });
    }
};

extensionApi.runtime.onInstalled.addListener(async () => {
    await migrateLegacyConfig();
    await Logger.info('Flow2API Token Updater installed');
    await refreshSafetyAlarm();
});

if (extensionApi.runtime.onStartup) {
    extensionApi.runtime.onStartup.addListener(async () => {
        await migrateLegacyConfig();
        await refreshSafetyAlarm();

        const settings = await loadSettings();
        if (settings.baseUrl && settings.connectionToken) {
            await syncCurrentSession({
                reason: 'startup',
                allowLabsWakeup: false,
                notifyOnError: false
            });
        }
    });
}

extensionApi.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request).then(sendResponse).catch((error) => {
        sendResponse({
            success: false,
            error: error.message
        });
    });

    return true;
});

if (extensionApi.cookies?.onChanged) {
    extensionApi.cookies.onChanged.addListener((changeInfo) => {
        if (!isTrackedSessionCookie(changeInfo.cookie)) {
            return;
        }

        if (changeInfo.removed) {
            void handleLabsSessionRemoved(changeInfo);
            return;
        }

        void syncCurrentSession({
            reason: 'cookie_changed',
            allowLabsWakeup: false,
            notifyOnError: true
        });
    });
}

extensionApi.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== SYNC_ALARM_NAME) {
        return;
    }

    await syncCurrentSession({
        reason: 'scheduled_check',
        allowLabsWakeup: false,
        notifyOnError: true
    });
});

async function handleMessage(request = {}) {
    switch (request.action) {
        case 'getSetupData':
            return getSetupData();
        case 'connectBaseUrl':
            return connectBaseUrl(request.baseUrl);
        case 'syncNow':
            return syncCurrentSession({
                reason: 'manual_sync',
                allowLabsWakeup: true,
                notifyOnError: false
            });
        case 'openConsole':
            return openConsole(request.baseUrl);
        case 'getLogs':
            return {
                success: true,
                logs: await Logger.getLogs()
            };
        case 'clearLogs':
            await Logger.clearLogs();
            return { success: true };
        default:
            return {
                success: false,
                error: '未知操作'
            };
    }
}

async function getSetupData() {
    await migrateLegacyConfig();

    const settings = await loadSettings();
    const suggestedBaseUrl = await getSuggestedBaseUrl(settings.baseUrl);

    if (settings.baseUrl && !settings.connectionToken && await hasOriginPermission(settings.baseUrl)) {
        await hydrateConnectionFromConsole(settings.baseUrl, { openIfMissing: false, activateOnNeedsLogin: false });
    }

    const hydratedSettings = await loadSettings();

    return {
        success: true,
        settings: hydratedSettings,
        hasConnection: Boolean(hydratedSettings.connectionToken),
        browserInfo: await getBrowserInfoSafe(),
        suggestedBaseUrl
    };
}

async function connectBaseUrl(rawBaseUrl) {
    const normalized = normalizeBaseUrl(rawBaseUrl);

    await extensionApi.storage.local.set({
        baseUrl: normalized.origin
    });

    const permissionGranted = await hasOriginPermission(normalized.origin);
    if (!permissionGranted) {
        throw new Error('需要先授权访问这个 Flow2API 域名');
    }

    const connection = await hydrateConnectionFromConsole(normalized.origin, {
        openIfMissing: true,
        activateOnNeedsLogin: true
    });

    if (!connection.success) {
        return connection;
    }

    const syncResult = await syncCurrentSession({
        reason: 'manual_connect',
        allowLabsWakeup: true,
        notifyOnError: false,
        adminToken: connection.adminToken,
        baseUrl: normalized.origin
    });

    if (syncResult.success) {
        return {
            ...syncResult,
            success: true,
            hasConnection: true,
            synced: true
        };
    }

    return {
        success: true,
        hasConnection: true,
        synced: false,
        lastSync: syncResult.lastSync || (await loadSettings()).lastSync,
        message: syncResult.lastSync?.status === 'waiting_session'
            ? WAITING_FOR_LABS_MESSAGE
            : `Flow2API 已接入，但当前这个 Profile 的首次同步失败：${syncResult.error || '未知错误'}`
    };
}

async function openConsole(rawBaseUrl) {
    const settings = await loadSettings();
    const normalized = normalizeBaseUrl(rawBaseUrl || settings.baseUrl);
    const tab = await focusOrCreateTab(`${normalized.origin}/manage`);

    return {
        success: true,
        tabId: tab.id
    };
}

async function syncCurrentSession({
    reason,
    allowLabsWakeup,
    notifyOnError,
    adminToken = null,
    baseUrl = null
}) {
    if (runtimeState.activeSync) {
        return runtimeState.activeSync;
    }

    runtimeState.activeSync = performSync({
        reason,
        allowLabsWakeup,
        notifyOnError,
        adminToken,
        baseUrl
    }).finally(() => {
        runtimeState.activeSync = null;
    });

    return runtimeState.activeSync;
}

async function performSync({
    reason,
    allowLabsWakeup,
    notifyOnError,
    adminToken,
    baseUrl
}) {
    await migrateLegacyConfig();

    const settings = await loadSettings();
    const effectiveBaseUrl = baseUrl || settings.baseUrl;

    if (!effectiveBaseUrl) {
        return {
            success: false,
            error: '请先填写 Flow2API 地址'
        };
    }

    if (!settings.connectionToken) {
        const hydrated = await hydrateConnectionFromConsole(effectiveBaseUrl, {
            openIfMissing: reason === 'manual_connect',
            activateOnNeedsLogin: reason === 'manual_connect'
        });

        if (!hydrated.success) {
            return hydrated;
        }

        adminToken = adminToken || hydrated.adminToken;
        settings.connectionToken = hydrated.connectionToken;
    }

    if (!await hasOriginPermission(effectiveBaseUrl)) {
        return {
            success: false,
            error: '扩展尚未获得这个 Flow2API 域名的访问权限'
        };
    }

    try {
        await Logger.info('Starting session sync', {
            reason,
            baseUrl: effectiveBaseUrl
        });

        const sessionCookie = await getSessionCookie({
            loadIfMissing: allowLabsWakeup
        });

        if (!sessionCookie?.value) {
            throw new Error('未找到当前 Profile 的 Google Labs 登录态，请先在这个 Profile 里登录 Labs');
        }

        let derivedAccount = null;

        if (!adminToken) {
            const adminSession = await getAdminSessionFromConsole(effectiveBaseUrl, {
                openIfMissing: false,
                activateOnNeedsLogin: false
            });

            if (adminSession.success) {
                adminToken = adminSession.adminToken;
            }
        }

        if (adminToken) {
            try {
                derivedAccount = await convertSessionToken(effectiveBaseUrl, adminToken, sessionCookie.value);
            } catch (error) {
                await Logger.info('ST metadata lookup skipped', {
                    reason: error.message
                });
            }
        }

        const syncPayload = await pushSessionToken(effectiveBaseUrl, settings.connectionToken, sessionCookie.value);
        const email = derivedAccount?.email || extractEmail(syncPayload.message) || settings.lastSync?.email || null;
        const atExpires = derivedAccount?.expires || null;
        const sessionExpiresAt = formatCookieExpiry(sessionCookie);

        const lastSync = {
            status: 'success',
            reason,
            syncedAt: new Date().toISOString(),
            email,
            atExpires,
            sessionExpiresAt,
            action: syncPayload.action || null,
            message: syncPayload.message || '同步成功'
        };

        await extensionApi.storage.local.set({ lastSync });
        await refreshSafetyAlarm(sessionCookie);

        await Logger.success('Session synced to Flow2API', {
            reason,
            email,
            action: syncPayload.action || null,
            baseUrl: effectiveBaseUrl,
            sessionExpiresAt
        });

        return {
            success: true,
            lastSync,
            message: syncPayload.message || '同步成功'
        };
    } catch (error) {
        const waitingForLabs = isMissingLabsSessionError(error);
        const lastSync = waitingForLabs
            ? createWaitingSessionState(settings.lastSync, reason)
            : {
                status: 'error',
                reason,
                syncedAt: settings.lastSync?.syncedAt || null,
                checkedAt: new Date().toISOString(),
                email: settings.lastSync?.email || null,
                atExpires: settings.lastSync?.atExpires || null,
                sessionExpiresAt: settings.lastSync?.sessionExpiresAt || null,
                action: null,
                message: error.message
            };

        await extensionApi.storage.local.set({ lastSync });
        await (waitingForLabs ? Logger.info : Logger.error).call(Logger, waitingForLabs ? 'Waiting for Google Labs session' : 'Session sync failed', {
            reason,
            error: error.message
        });

        if (notifyOnError && !waitingForLabs) {
            await createNotification('Flow2API 同步失败', error.message);
        }

        return {
            success: false,
            error: waitingForLabs ? WAITING_FOR_LABS_MESSAGE : error.message,
            lastSync
        };
    }
}

async function hydrateConnectionFromConsole(baseUrl, {
    openIfMissing,
    activateOnNeedsLogin
}) {
    const normalized = normalizeBaseUrl(baseUrl);
    const permissionGranted = await hasOriginPermission(normalized.origin);

    if (!permissionGranted) {
        return {
            success: false,
            error: '尚未授予这个 Flow2API 域名的访问权限'
        };
    }

    const adminSession = await getAdminSessionFromConsole(normalized.origin, {
        openIfMissing,
        activateOnNeedsLogin
    });

    if (!adminSession.success) {
        return adminSession;
    }

    const pluginConfig = await ensurePluginConfig(normalized.origin, adminSession.adminToken);
    const connectionToken = (pluginConfig.connectionToken || '').trim();

    if (!connectionToken) {
        throw new Error('无法从 Flow2API 控制台读取连接 Token');
    }

    await extensionApi.storage.local.set({
        baseUrl: normalized.origin,
        connectionToken
    });
    await saveSharedConfig(normalized.origin, connectionToken);

    await Logger.success('Flow2API connection discovered from console', {
        baseUrl: normalized.origin
    });

    return {
        success: true,
        baseUrl: normalized.origin,
        adminToken: adminSession.adminToken,
        connectionToken
    };
}

async function getAdminSessionFromConsole(baseUrl, {
    openIfMissing,
    activateOnNeedsLogin
}) {
    const candidates = await findConsoleTabs(baseUrl);

    for (const tab of candidates) {
        const probe = await probeFlow2ApiTab(tab.id);

        if (probe?.adminToken) {
            return {
                success: true,
                adminToken: probe.adminToken,
                tabId: tab.id,
                pageKind: probe.pageKind
            };
        }
    }

    const targetTab = candidates[0] || null;

    if (targetTab && activateOnNeedsLogin) {
        await extensionApi.tabs.update(targetTab.id, { active: true });

        if (typeof targetTab.windowId === 'number' && extensionApi.windows?.update) {
            await extensionApi.windows.update(targetTab.windowId, { focused: true });
        }
    }

    if (!targetTab && openIfMissing) {
        const tab = await focusOrCreateTab(`${baseUrl}/manage`);

        return {
            success: false,
            needsLogin: true,
            openedConsole: true,
            message: '已打开 Flow2API 控制台，请先登录后台，然后再点一次“连接并同步”'
        };
    }

    return {
        success: false,
        needsLogin: true,
        openedConsole: false,
        message: '请先在当前浏览器里登录 Flow2API 控制台'
    };
}

async function ensurePluginConfig(baseUrl, adminToken) {
    const configResponse = await requestJson(`${baseUrl}/api/plugin/config`, {
        authToken: adminToken
    });

    if (configResponse.response.status === 401) {
        throw new Error('Flow2API 控制台登录已过期，请重新登录');
    }

    if (!configResponse.response.ok) {
        throw new Error(readHttpError(configResponse, '读取插件连接配置失败'));
    }

    const currentConfig = configResponse.data?.config || {};
    if (typeof currentConfig.connection_token === 'string' && currentConfig.connection_token.trim()) {
        return {
            connectionToken: currentConfig.connection_token.trim()
        };
    }

    const createResponse = await requestJson(`${baseUrl}/api/plugin/config`, {
        method: 'POST',
        authToken: adminToken,
        body: {
            connection_token: '',
            auto_enable_on_update: true
        }
    });

    if (!createResponse.response.ok) {
        throw new Error(readHttpError(createResponse, '自动生成插件连接 Token 失败'));
    }

    return {
        connectionToken: typeof createResponse.data?.connection_token === 'string'
            ? createResponse.data.connection_token.trim()
            : ''
    };
}

async function convertSessionToken(baseUrl, adminToken, sessionToken) {
    const response = await requestJson(`${baseUrl}/api/tokens/st2at`, {
        method: 'POST',
        authToken: adminToken,
        body: {
            st: sessionToken
        }
    });

    if (!response.response.ok || !response.data?.success) {
        throw new Error(readHttpError(response, '读取账号信息失败'));
    }

    return {
        email: response.data.email || null,
        expires: response.data.expires || null
    };
}

async function pushSessionToken(baseUrl, connectionToken, sessionToken) {
    const response = await requestJson(`${baseUrl}/api/plugin/update-token`, {
        method: 'POST',
        authToken: connectionToken,
        body: {
            session_token: sessionToken
        }
    });

    if (!response.response.ok) {
        throw new Error(readHttpError(response, '向 Flow2API 同步登录态失败'));
    }

    if (response.data?.success === false) {
        throw new Error(response.data.message || 'Flow2API 返回了失败结果');
    }

    return response.data || {};
}

async function requestJson(url, { method = 'GET', authToken = null, body = undefined } = {}) {
    const headers = {
        'Accept': 'application/json'
    };

    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }

    let payload;
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }

    const response = await fetch(url, {
        method,
        headers,
        body: payload
    });

    const text = await response.text();
    let data = null;

    if (text) {
        try {
            data = JSON.parse(text);
        } catch (error) {
            data = text;
        }
    }

    return { response, data };
}

function readHttpError(result, fallbackMessage) {
    const response = result.response;
    const data = result.data;

    if (typeof data === 'string' && data.trim()) {
        return `${fallbackMessage} (${response.status}): ${data.trim()}`;
    }

    const message = data?.detail || data?.message || data?.error;
    if (typeof message === 'string' && message.trim()) {
        return `${fallbackMessage} (${response.status}): ${message.trim()}`;
    }

    return `${fallbackMessage} (${response.status})`;
}

async function getSessionCookie({ loadIfMissing }) {
    let cookie = await findSessionCookie();

    if (!cookie && loadIfMissing) {
        const tab = await openLabsTab();

        try {
            await waitForTabLoad(tab.id);
            await sleep(SESSION_WAIT_MS);
            cookie = await findSessionCookie();
        } finally {
            await closeTabIfNeeded(tab.id);
        }
    }

    return cookie;
}

async function findSessionCookie() {
    const storeIds = await collectCandidateCookieStoreIds();
    const candidates = [];
    const seen = new Set();

    for (const details of buildSessionCookieQueries(storeIds)) {
        const cookies = await safeGetAllCookies(details);

        for (const cookie of cookies) {
            if (!cookie?.value) {
                continue;
            }

            const key = serializeCookieIdentity(cookie);
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            candidates.push(cookie);
        }
    }

    const preferred = pickPreferredSessionCookie(candidates);

    if (!preferred) {
        await Logger.info('Google Labs session cookie not found', {
            storeIds,
            checkedVariants: buildSessionCookieQueries(storeIds).length
        });
    }

    return preferred;
}

async function openLabsTab() {
    return extensionApi.tabs.create({
        url: LABS_URL,
        active: false
    });
}

async function waitForTabLoad(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
    try {
        const tab = await extensionApi.tabs.get(tabId);
        if (tab?.status === 'complete') {
            return;
        }
    } catch (error) {
        // Fall through to listener path.
    }

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error('等待 Google Labs 页面加载超时'));
        }, timeoutMs);

        const listener = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                cleanup();
                resolve();
            }
        };

        const cleanup = () => {
            clearTimeout(timeoutId);
            extensionApi.tabs.onUpdated.removeListener(listener);
        };

        extensionApi.tabs.onUpdated.addListener(listener);
    });
}

async function closeTabIfNeeded(tabId) {
    if (typeof tabId !== 'number') {
        return;
    }

    try {
        await extensionApi.tabs.remove(tabId);
    } catch (error) {
        // Ignore tab closing errors.
    }
}

async function refreshSafetyAlarm(cookie = null) {
    await extensionApi.alarms.clear(SYNC_ALARM_NAME);

    const settings = await loadSettings();
    if (!settings.baseUrl || !settings.connectionToken) {
        return;
    }

    const sessionCookie = cookie || await findSessionCookie();
    const now = Date.now();
    const fallbackAt = now + DEFAULT_SAFETY_SYNC_MINUTES * 60 * 1000;
    let when = fallbackAt;

    if (sessionCookie?.expirationDate) {
        const desired = sessionCookie.expirationDate * 1000 - EARLY_REFRESH_MS;
        const minimum = now + 15 * 60 * 1000;
        when = Math.max(minimum, desired);
    }

    extensionApi.alarms.create(SYNC_ALARM_NAME, { when });

    await Logger.info('Safety sync scheduled', {
        scheduledAt: new Date(when).toISOString()
    });
}

async function handleLabsSessionRemoved(changeInfo) {
    await Logger.info('Google Labs session cookie removed', {
        cause: changeInfo.cause
    });

    const settings = await loadSettings();
    if (!settings.connectionToken) {
        return;
    }

    const lastSync = createWaitingSessionState(settings.lastSync, 'cookie_removed');
    await extensionApi.storage.local.set({ lastSync });
}

async function collectCandidateCookieStoreIds() {
    const ids = new Set();

    if (typeof extensionApi.cookies?.getAllCookieStores === 'function') {
        try {
            const stores = await extensionApi.cookies.getAllCookieStores();
            for (const store of stores) {
                if (store?.id) {
                    ids.add(store.id);
                }
            }
        } catch (error) {
            // Ignore store enumeration errors.
        }
    }

    try {
        const tabs = await extensionApi.tabs.query({});

        for (const tab of tabs) {
            if (!tab?.url || !tab.cookieStoreId) {
                continue;
            }

            try {
                if (new URL(tab.url).origin === 'https://labs.google') {
                    ids.add(tab.cookieStoreId);
                }
            } catch (error) {
                // Ignore invalid tab URLs.
            }
        }
    } catch (error) {
        // Ignore tab enumeration errors.
    }

    return ids.size > 0 ? [...ids] : [null];
}

function buildSessionCookieQueries(storeIds) {
    const variants = [
        { domain: 'labs.google', name: SESSION_COOKIE_NAME },
        { url: LABS_COOKIE_URL, name: SESSION_COOKIE_NAME },
        { domain: 'labs.google', name: SESSION_COOKIE_NAME, firstPartyDomain: null },
        { url: LABS_COOKIE_URL, name: SESSION_COOKIE_NAME, firstPartyDomain: null },
        { domain: 'labs.google', name: SESSION_COOKIE_NAME, partitionKey: {} },
        { url: LABS_COOKIE_URL, name: SESSION_COOKIE_NAME, partitionKey: {} },
        { domain: 'labs.google', name: SESSION_COOKIE_NAME, firstPartyDomain: null, partitionKey: {} },
        { url: LABS_COOKIE_URL, name: SESSION_COOKIE_NAME, firstPartyDomain: null, partitionKey: {} }
    ];

    const queries = [];

    for (const variant of variants) {
        for (const storeId of storeIds) {
            queries.push(storeId ? { ...variant, storeId } : { ...variant });
        }
    }

    return queries;
}

async function safeGetAllCookies(details) {
    try {
        const cookies = await extensionApi.cookies.getAll(details);
        return Array.isArray(cookies) ? cookies : [];
    } catch (error) {
        return [];
    }
}

function serializeCookieIdentity(cookie) {
    return [
        cookie.storeId || '',
        cookie.firstPartyDomain || '',
        cookie.partitionKey?.topLevelSite || '',
        cookie.domain || '',
        cookie.path || '',
        cookie.name || '',
        cookie.value || ''
    ].join('|');
}

function pickPreferredSessionCookie(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) {
        return null;
    }

    return [...cookies]
        .sort((left, right) => scoreSessionCookie(right) - scoreSessionCookie(left))
        .find((cookie) => cookie?.value) || null;
}

function scoreSessionCookie(cookie) {
    if (!cookie) {
        return 0;
    }

    let score = 0;
    const domain = `${cookie.domain || ''}`.replace(/^\./, '');

    if (domain === 'labs.google') {
        score += 8;
    }

    if (cookie.path === '/') {
        score += 4;
    }

    if (typeof cookie.expirationDate === 'number') {
        score += Math.floor(cookie.expirationDate / 1000);
    }

    return score;
}

async function findConsoleTabs(baseUrl) {
    try {
        const tabs = await extensionApi.tabs.query({});

        return tabs
            .filter((tab) => {
                if (!tab.url) {
                    return false;
                }

                try {
                    return new URL(tab.url).origin === baseUrl;
                } catch (error) {
                    return false;
                }
            })
            .sort((left, right) => scoreConsoleTab(right) - scoreConsoleTab(left));
    } catch (error) {
        await Logger.info('Failed to enumerate Flow2API tabs', {
            error: error.message
        });
        return [];
    }
}

function scoreConsoleTab(tab) {
    try {
        const url = new URL(tab.url);

        if (url.pathname.startsWith('/manage')) {
            return 4;
        }

        if (url.pathname.startsWith('/login')) {
            return 3;
        }

        return tab.active ? 2 : 1;
    } catch (error) {
        return 0;
    }
}

async function probeFlow2ApiTab(tabId) {
    const result = await executeInTab(tabId, function probePageContext() {
        const directResult = {
            href: location.href,
            origin: location.origin,
            pageKind: location.pathname.startsWith('/manage')
                ? 'manage'
                : (location.pathname.startsWith('/login') ? 'login' : 'other'),
            adminToken: ''
        };

        try {
            directResult.adminToken = localStorage.getItem('adminToken') || '';
            if (directResult.adminToken) {
                return directResult;
            }
        } catch (error) {
            // Fall back to page-context probe below.
        }

        return new Promise((resolve) => {
            const requestId = `flow2api_${Math.random().toString(36).slice(2, 10)}`;
            const timeoutId = setTimeout(() => {
                cleanup({
                    ...directResult,
                    error: 'timeout'
                });
            }, 1500);

            const handleMessage = (event) => {
                if (event.source !== window) {
                    return;
                }

                const message = event.data;
                if (!message || message.source !== 'flow2api-token-updater' || message.requestId !== requestId) {
                    return;
                }

                cleanup({
                    ...directResult,
                    ...message.payload
                });
            };

            const cleanup = (payload) => {
                clearTimeout(timeoutId);
                window.removeEventListener('message', handleMessage);
                resolve(payload);
            };

            window.addEventListener('message', handleMessage);

            const script = document.createElement('script');
            script.textContent = `
                (() => {
                    const requestId = ${JSON.stringify(requestId)};
                    try {
                        window.postMessage({
                            source: 'flow2api-token-updater',
                            requestId,
                            payload: {
                                adminToken: localStorage.getItem('adminToken') || ''
                            }
                        }, '*');
                    } catch (error) {
                        window.postMessage({
                            source: 'flow2api-token-updater',
                            requestId,
                            payload: {
                                adminToken: '',
                                error: String(error && error.message ? error.message : error)
                            }
                        }, '*');
                    }
                })();
            `;

            (document.documentElement || document.head || document.body).appendChild(script);
            script.remove();
        });
    });

    return result || null;
}

async function executeInTab(tabId, func) {
    if (extensionApi.scripting?.executeScript) {
        const results = await extensionApi.scripting.executeScript({
            target: { tabId },
            func
        });

        return results?.[0]?.result;
    }

    if (typeof extensionApi.tabs.executeScript === 'function') {
        const code = `(${func.toString()})()`;
        const results = await extensionApi.tabs.executeScript(tabId, { code });
        return results?.[0];
    }

    throw new Error('当前浏览器不支持页面探测脚本');
}

async function focusOrCreateTab(url) {
    const tabs = await extensionApi.tabs.query({});
    const existing = tabs.find((tab) => tab.url === url) || null;

    if (existing) {
        await extensionApi.tabs.update(existing.id, { active: true });

        if (typeof existing.windowId === 'number' && extensionApi.windows?.update) {
            await extensionApi.windows.update(existing.windowId, { focused: true });
        }

        return existing;
    }

    return extensionApi.tabs.create({ url, active: true });
}

async function getSuggestedBaseUrl(savedBaseUrl) {
    if (savedBaseUrl) {
        return null;
    }

    try {
        const tabs = await extensionApi.tabs.query({
            active: true,
            currentWindow: true
        });

        const activeTab = tabs[0];
        if (!activeTab?.url) {
            return null;
        }

        const url = new URL(activeTab.url);
        const title = (activeTab.title || '').toLowerCase();

        if (!['http:', 'https:'].includes(url.protocol)) {
            return null;
        }

        if (url.pathname.startsWith('/manage') || url.pathname.startsWith('/login') || title.includes('flow2api')) {
            return url.origin;
        }
    } catch (error) {
        return null;
    }

    return null;
}

async function hasOriginPermission(origin) {
    if (!extensionApi.permissions?.contains) {
        return true;
    }

    try {
        return await extensionApi.permissions.contains({
            origins: [`${origin}/*`]
        });
    } catch (error) {
        return false;
    }
}

async function loadSettings() {
    const [stored, synced] = await Promise.all([
        extensionApi.storage.local.get([
            'baseUrl',
            'connectionToken',
            'lastSync'
        ]),
        safeGetSyncStorage([
            SHARED_BASE_URL_KEY,
            SHARED_CONNECTION_TOKEN_KEY
        ])
    ]);

    const localBaseUrl = typeof stored.baseUrl === 'string' ? stored.baseUrl.trim() : '';
    const localConnectionToken = typeof stored.connectionToken === 'string'
        ? stored.connectionToken.trim()
        : '';
    const sharedBaseUrl = typeof synced[SHARED_BASE_URL_KEY] === 'string'
        ? synced[SHARED_BASE_URL_KEY].trim()
        : '';
    const sharedConnectionToken = typeof synced[SHARED_CONNECTION_TOKEN_KEY] === 'string'
        ? synced[SHARED_CONNECTION_TOKEN_KEY].trim()
        : '';

    return {
        baseUrl: localBaseUrl || sharedBaseUrl,
        connectionToken: localConnectionToken || sharedConnectionToken,
        lastSync: stored.lastSync && typeof stored.lastSync === 'object' ? stored.lastSync : null,
        configSource: localBaseUrl || localConnectionToken
            ? 'local'
            : ((sharedBaseUrl || sharedConnectionToken) ? 'sync' : 'none')
    };
}

async function migrateLegacyConfig() {
    const [localStored, syncStored] = await Promise.all([
        extensionApi.storage.local.get([
            'baseUrl',
            'connectionToken',
            'apiUrl',
            ACCOUNT_SECRETS_KEY
        ]),
        safeGetSyncStorage(['accounts', 'apiUrl', 'connectionToken'])
    ]);

    if (localStored.baseUrl && localStored.connectionToken) {
        return false;
    }

    let legacyApiUrl = typeof localStored.apiUrl === 'string' ? localStored.apiUrl.trim() : '';
    let legacyConnectionToken = typeof localStored.connectionToken === 'string'
        ? localStored.connectionToken.trim()
        : '';

    if (!legacyApiUrl || !legacyConnectionToken) {
        const localSecrets = normalizeSecretsMap(localStored[ACCOUNT_SECRETS_KEY]);
        const account = pickPrimaryAccount(
            Array.isArray(syncStored.accounts)
                ? syncStored.accounts.map((item) => normalizeLegacyAccount({
                    ...item,
                    connectionToken: resolveLegacySecret(item, localSecrets)
                }))
                : []
        );

        if (account?.apiUrl && account?.connectionToken) {
            legacyApiUrl = account.apiUrl;
            legacyConnectionToken = account.connectionToken;
        }
    }

    if ((!legacyApiUrl || !legacyConnectionToken) && syncStored.apiUrl && syncStored.connectionToken) {
        legacyApiUrl = syncStored.apiUrl.trim();
        legacyConnectionToken = syncStored.connectionToken.trim();
    }

    if (!legacyApiUrl || !legacyConnectionToken) {
        return false;
    }

    const baseUrl = normalizeBaseUrl(legacyApiUrl).origin;

    await extensionApi.storage.local.set({
        baseUrl,
        connectionToken: legacyConnectionToken
    });
    await saveSharedConfig(baseUrl, legacyConnectionToken);

    await Logger.info('Legacy config migrated to single baseUrl model', {
        baseUrl
    });

    return true;
}

async function safeGetSyncStorage(keys) {
    try {
        return await extensionApi.storage.sync.get(keys);
    } catch (error) {
        return {};
    }
}

async function saveSharedConfig(baseUrl, connectionToken) {
    try {
        await extensionApi.storage.sync.set({
            [SHARED_BASE_URL_KEY]: baseUrl,
            [SHARED_CONNECTION_TOKEN_KEY]: connectionToken
        });
    } catch (error) {
        await Logger.info('Shared config sync skipped', {
            error: error.message
        });
    }
}

function pickPrimaryAccount(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
        return null;
    }

    return accounts.find((account) => account.apiUrl && account.connectionToken) || accounts[0];
}

function normalizeLegacyAccount(account = {}) {
    return {
        apiUrl: typeof account.apiUrl === 'string' ? account.apiUrl.trim() : '',
        connectionToken: typeof account.connectionToken === 'string' ? account.connectionToken.trim() : ''
    };
}

function normalizeSecretsMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(value)
            .filter(([, token]) => typeof token === 'string' && token.trim())
            .map(([accountId, token]) => [accountId, token.trim()])
    );
}

function resolveLegacySecret(account, localSecrets) {
    if (account?.id && typeof localSecrets[account.id] === 'string' && localSecrets[account.id].trim()) {
        return localSecrets[account.id].trim();
    }

    if (typeof account?.connectionToken === 'string') {
        return account.connectionToken.trim();
    }

    return '';
}

function normalizeBaseUrl(rawValue) {
    const input = typeof rawValue === 'string' ? rawValue.trim() : '';

    if (!input) {
        throw new Error('请填写 Flow2API 地址');
    }

    let candidate = input;
    if (!/^[a-z]+:\/\//i.test(candidate)) {
        candidate = `https://${candidate}`;
    }

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch (error) {
        throw new Error('Flow2API 地址不是合法网址');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Flow2API 地址必须以 http:// 或 https:// 开头');
    }

    return {
        origin: parsed.origin
    };
}

function isTrackedSessionCookie(cookie) {
    if (!cookie || cookie.name !== SESSION_COOKIE_NAME) {
        return false;
    }

    const domain = `${cookie.domain || ''}`.replace(/^\./, '');
    return domain === 'labs.google';
}

function isMissingLabsSessionError(errorOrMessage) {
    const message = typeof errorOrMessage === 'string'
        ? errorOrMessage
        : errorOrMessage?.message;

    return typeof message === 'string'
        && message.includes('Google Labs 登录态')
        && message.includes('未找到');
}

function createWaitingSessionState(previousLastSync, reason) {
    return {
        status: 'waiting_session',
        reason,
        syncedAt: previousLastSync?.syncedAt || null,
        checkedAt: new Date().toISOString(),
        email: previousLastSync?.email || null,
        atExpires: previousLastSync?.atExpires || null,
        sessionExpiresAt: previousLastSync?.sessionExpiresAt || null,
        action: null,
        message: WAITING_FOR_LABS_MESSAGE
    };
}

function formatCookieExpiry(cookie) {
    if (!cookie?.expirationDate) {
        return null;
    }

    return new Date(cookie.expirationDate * 1000).toISOString();
}

function extractEmail(message) {
    if (typeof message !== 'string') {
        return null;
    }

    const match = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : null;
}

async function createNotification(title, message) {
    try {
        await extensionApi.notifications.create({
            type: 'basic',
            iconUrl: 'icon48.png',
            title,
            message
        });
    } catch (error) {
        await Logger.info('Notification skipped', {
            error: error.message
        });
    }
}

async function getBrowserInfoSafe() {
    if (typeof extensionApi.runtime.getBrowserInfo !== 'function') {
        return null;
    }

    try {
        return await extensionApi.runtime.getBrowserInfo();
    } catch (error) {
        return null;
    }
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
