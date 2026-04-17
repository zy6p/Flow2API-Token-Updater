const extensionApi = globalThis.browser ?? globalThis.chrome;

const LABS_URL = 'https://labs.google/fx/vi/tools/flow';
const LABS_COOKIE_URL = 'https://labs.google/';
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const WAITING_FOR_LABS_MESSAGE = 'Flow2API 已接入。当前 Profile 的 Google Labs 会话暂时不可用，扩展会后台自动重试；如果浏览器登录本身也失效了，再手动登录一次即可。';
const PRESERVE_EXISTING_TOKEN_MESSAGE = '当前无法验证 Google Labs 会话，扩展已保留现有 token，不会用未验证的 Cookie 覆盖；稍后会继续自动重试。';
const ACCOUNT_SECRETS_KEY = 'accountSecrets';
const SHARED_BASE_URL_KEY = 'sharedBaseUrl';
const SHARED_CONNECTION_TOKEN_KEY = 'sharedConnectionToken';
const LEGACY_SYNC_CONFIG_KEYS = [
    SHARED_BASE_URL_KEY,
    SHARED_CONNECTION_TOKEN_KEY,
    'accounts',
    'apiUrl',
    'connectionToken'
];
const DEFAULT_STORE_KEY = '__default__';
const CONFIG_BY_STORE_KEY = 'configByStore';
const LAST_SYNC_BY_STORE_KEY = 'lastSyncByStore';
const LAST_SYNC_BY_SESSION_KEY = 'lastSyncBySession';
const SESSION_CONTEXT_BY_STORE_KEY = 'sessionContextByStore';
const CONSOLE_CONTEXT_BY_STORE_KEY = 'consoleContextByStore';
const UNSET_VALUE = Symbol('unsetValue');
const SYNC_ALARM_NAME = 'flow2apiSafetySync';
const DEFAULT_SAFETY_SYNC_MINUTES = 360;
const WAITING_RETRY_MINUTES = 5;
const EARLY_REFRESH_MS = 30 * 60 * 1000;
const ACCESS_TOKEN_EARLY_REFRESH_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_MINIMUM_REFRESH_MS = 60 * 1000;
const HEURISTIC_FAST_PROBE_MS = 5 * 60 * 1000;
const HEURISTIC_MEDIUM_PROBE_MS = 15 * 60 * 1000;
const HEURISTIC_SLOW_PROBE_MS = 60 * 60 * 1000;
const HEURISTIC_MAX_PROBE_MS = 12 * 60 * 60 * 1000;
const MAX_BACKGROUND_WAKEUP_TABS = 6;
const TAB_LOAD_TIMEOUT_MS = 20000;
const SESSION_DISCOVERY_TIMEOUT_MS = 10000;
const SESSION_DISCOVERY_INTERVAL_MS = 500;
const CONSOLE_DISCOVERY_TIMEOUT_MS = 5000;

const runtimeState = {
    activeSyncByStore: new Map()
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
    await clearLegacySharedConfig();
    await Logger.info('Flow2API Token Updater installed');
    await refreshSafetyAlarm();
});

if (extensionApi.runtime.onStartup) {
    extensionApi.runtime.onStartup.addListener(async () => {
        await migrateLegacyConfig();
        await clearLegacySharedConfig();
        await refreshSafetyAlarm();

        const configuredStoreIds = await collectConfiguredCookieStoreIds();
        if (configuredStoreIds.length > 0) {
            await syncConfiguredSessions({
                reason: 'startup',
                allowLabsWakeup: true,
                allowConsoleWakeup: true,
                notifyOnError: false
            });
        }
    });
}

extensionApi.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender).then(sendResponse).catch((error) => {
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

        void handleTrackedSessionCookieChange(changeInfo);
    });
}

extensionApi.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== SYNC_ALARM_NAME) {
        return;
    }

    await syncConfiguredSessions({
        reason: 'scheduled_check',
        allowLabsWakeup: true,
        allowConsoleWakeup: true,
        notifyOnError: true
    });
});

async function handleMessage(request = {}, sender = {}) {
    const cookieStoreId = resolveRequestedCookieStoreId(request, sender);

    switch (request.action) {
        case 'getSetupData':
            return getSetupData(cookieStoreId);
        case 'connectBaseUrl':
            return connectBaseUrl(request.baseUrl, cookieStoreId);
        case 'syncNow':
            return syncCurrentSession({
                reason: 'manual_sync',
                allowLabsWakeup: true,
                allowConsoleWakeup: true,
                notifyOnError: false,
                cookieStoreId
            });
        case 'openConsole':
            return openConsole(request.baseUrl, cookieStoreId);
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

function resolveRequestedCookieStoreId(request = {}, sender = {}) {
    return normalizeCookieStoreId(request.cookieStoreId || sender?.tab?.cookieStoreId || null);
}

async function getSetupData(cookieStoreId = null) {
    await migrateLegacyConfig();

    const settings = await loadSettings({ cookieStoreId });
    const suggestedBaseUrl = await getSuggestedBaseUrl(settings.baseUrl);
    const preferredCookieStoreId = settings.consoleContext?.cookieStoreId || normalizeCookieStoreId(cookieStoreId) || settings.sessionContext?.storeId || null;

    if (settings.baseUrl && !settings.connectionToken && await hasOriginPermission(settings.baseUrl)) {
        await hydrateConnectionFromConsole(settings.baseUrl, {
            openIfMissing: true,
            activateOnNeedsLogin: false,
            preferredCookieStoreId,
            configCookieStoreId: cookieStoreId
        });
    }

    const hydratedSettings = await loadSettings({ cookieStoreId });
    const currentSessionState = await detectCurrentSessionState({
        cookieStoreId,
        settings: hydratedSettings
    });
    const effectiveLastSync = selectDisplayedLastSync(
        hydratedSettings.lastSync,
        currentSessionState
    );

    return {
        success: true,
        settings: {
            ...hydratedSettings,
            lastSync: effectiveLastSync
        },
        hasConnection: Boolean(hydratedSettings.connectionToken),
        browserInfo: await getBrowserInfoSafe(),
        suggestedBaseUrl
    };
}

async function connectBaseUrl(rawBaseUrl, cookieStoreId = null) {
    const normalized = normalizeBaseUrl(rawBaseUrl);
    const preferredCookieStoreId = normalizeCookieStoreId(cookieStoreId);

    await saveScopedConfig(preferredCookieStoreId, {
        baseUrl: normalized.origin
    });

    const permissionGranted = await hasOriginPermission(normalized.origin);
    if (!permissionGranted) {
        throw new Error('需要先授权访问这个 Flow2API 域名');
    }

    const connection = await hydrateConnectionFromConsole(normalized.origin, {
        openIfMissing: true,
        activateOnNeedsLogin: true,
        preferredCookieStoreId,
        configCookieStoreId: cookieStoreId
    });

    if (!connection.success) {
        return connection;
    }

    const syncResult = await syncCurrentSession({
        reason: 'manual_connect',
        allowLabsWakeup: true,
        allowConsoleWakeup: true,
        notifyOnError: false,
        adminToken: connection.adminToken,
        baseUrl: normalized.origin,
        cookieStoreId
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
        lastSync: syncResult.lastSync || (await loadSettings({ cookieStoreId })).lastSync,
        message: syncResult.lastSync?.status === 'waiting_session'
            ? WAITING_FOR_LABS_MESSAGE
            : `Flow2API 已接入，但当前这个 Profile 的首次同步失败：${syncResult.error || '未知错误'}`
    };
}

async function openConsole(rawBaseUrl, cookieStoreId = null) {
    const settings = await loadSettings({ cookieStoreId });
    const normalized = normalizeBaseUrl(rawBaseUrl || settings.baseUrl);
    const preferredCookieStoreId = settings.consoleContext?.cookieStoreId || normalizeCookieStoreId(cookieStoreId) || settings.sessionContext?.storeId || null;
    const tab = await focusOrCreateTab(`${normalized.origin}/manage`, preferredCookieStoreId);

    return {
        success: true,
        tabId: tab.id
    };
}

async function syncConfiguredSessions(options) {
    await migrateLegacyConfig();

    const cookieStoreIds = await collectConfiguredCookieStoreIds();
    if (cookieStoreIds.length === 0) {
        return {
            success: false,
            error: '请先填写 Flow2API 地址'
        };
    }

    let lastResult = {
        success: false,
        error: '请先填写 Flow2API 地址'
    };

    for (const cookieStoreId of cookieStoreIds) {
        lastResult = await syncCurrentSession({
            ...options,
            cookieStoreId
        });
    }

    return lastResult;
}

async function syncCurrentSession({
    reason,
    allowLabsWakeup,
    allowConsoleWakeup,
    notifyOnError,
    adminToken = null,
    baseUrl = null,
    cookieStoreId = null
}) {
    await migrateLegacyConfig();

    const resolvedCookieStoreId = await resolveConfiguredCookieStoreId(cookieStoreId);
    const syncKey = storeKeyFromCookieStoreId(resolvedCookieStoreId);

    if (runtimeState.activeSyncByStore.has(syncKey)) {
        return runtimeState.activeSyncByStore.get(syncKey);
    }

    const activeSync = performSync({
        reason,
        allowLabsWakeup,
        allowConsoleWakeup,
        notifyOnError,
        adminToken,
        baseUrl,
        cookieStoreId: resolvedCookieStoreId
    }).finally(() => {
        runtimeState.activeSyncByStore.delete(syncKey);
    });

    runtimeState.activeSyncByStore.set(syncKey, activeSync);
    return activeSync;
}

async function resolveConfiguredCookieStoreId(cookieStoreId) {
    const normalizedCookieStoreId = normalizeCookieStoreId(cookieStoreId);
    if (normalizedCookieStoreId) {
        return normalizedCookieStoreId;
    }

    const configuredCookieStoreIds = await collectConfiguredCookieStoreIds();
    if (configuredCookieStoreIds.length !== 1) {
        return null;
    }

    return normalizeCookieStoreId(configuredCookieStoreIds[0]);
}

async function performSync({
    reason,
    allowLabsWakeup,
    allowConsoleWakeup,
    notifyOnError,
    adminToken,
    baseUrl,
    cookieStoreId
}) {
    await migrateLegacyConfig();

    const settings = await loadSettings({ cookieStoreId });
    const effectiveBaseUrl = baseUrl || settings.baseUrl;
    const preferredConsoleCookieStoreId = settings.consoleContext?.cookieStoreId || normalizeCookieStoreId(cookieStoreId) || settings.sessionContext?.storeId || null;
    const preferredSessionContext = settings.sessionContext || buildStoreSessionPreference(cookieStoreId);

    if (!effectiveBaseUrl) {
        return {
            success: false,
            error: '请先填写 Flow2API 地址'
        };
    }

    if (!settings.connectionToken) {
        const hydrated = await hydrateConnectionFromConsole(effectiveBaseUrl, {
            openIfMissing: allowConsoleWakeup,
            activateOnNeedsLogin: reason === 'manual_connect',
            preferredCookieStoreId: preferredConsoleCookieStoreId,
            configCookieStoreId: cookieStoreId
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
            baseUrl: effectiveBaseUrl,
            cookieStoreId: normalizeCookieStoreId(cookieStoreId) || null
        });

        let derivedAccount = null;

        if (!adminToken) {
            const adminSession = await getAdminSessionFromConsole(effectiveBaseUrl, {
                openIfMissing: allowConsoleWakeup,
                activateOnNeedsLogin: false,
                preferredCookieStoreId: preferredConsoleCookieStoreId
            });

            if (adminSession.success) {
                adminToken = adminSession.adminToken;
            }
        }

        const sessionResolution = await resolveSessionCookie({
            baseUrl: effectiveBaseUrl,
            adminToken,
            loadIfMissing: allowLabsWakeup,
            preferredContext: preferredSessionContext
        });
        const sessionCookie = sessionResolution.cookie;
        derivedAccount = sessionResolution.derivedAccount;

        if (!sessionCookie?.value) {
            if (sessionResolution.invalidCandidates.length > 0) {
                throw new Error('当前识别到的 Google Labs Cookie 都已失效，扩展已忽略这些旧 Cookie；请重新激活 Labs 会话');
            }

            throw new Error('未找到当前 Profile 的 Google Labs 登录态，请先在这个 Profile 里登录 Labs');
        }

        if (!derivedAccount && !adminToken && shouldPreserveExistingToken(settings.lastSync, reason)) {
            throw new Error(PRESERVE_EXISTING_TOKEN_MESSAGE);
        }

        const pushResult = await pushSessionTokenWithRecovery({
            baseUrl: effectiveBaseUrl,
            connectionToken: settings.connectionToken,
            sessionToken: sessionCookie.value,
            allowConsoleWakeup,
            preferredCookieStoreId: preferredConsoleCookieStoreId
        });

        if (pushResult.connectionToken) {
            settings.connectionToken = pushResult.connectionToken;
        }

        if (!adminToken && pushResult.adminToken) {
            adminToken = pushResult.adminToken;
        }

        if (!derivedAccount && adminToken) {
            try {
                derivedAccount = await convertSessionToken(effectiveBaseUrl, adminToken, sessionCookie.value);
            } catch (error) {
                await Logger.info('ST metadata lookup skipped', {
                    reason: error.message
                });
            }
        }

        const syncPayload = pushResult.payload;
        const email = derivedAccount?.email || extractEmail(syncPayload.message) || settings.lastSync?.email || null;
        const atExpires = derivedAccount?.expires || null;
        const sessionExpiresAt = formatCookieExpiry(sessionCookie);
        const sessionContext = captureSessionContext(sessionCookie);

        const lastSync = {
            status: 'success',
            reason,
            syncedAt: new Date().toISOString(),
            email,
            atExpires,
            sessionExpiresAt,
            sessionFingerprint: fingerprintSessionToken(sessionCookie.value),
            action: syncPayload.action || null,
            message: syncPayload.message || '同步成功'
        };

        await saveScopedSettings(cookieStoreId, {
            lastSync,
            sessionContext
        });
        await saveSessionScopedLastSync(lastSync);
        await refreshSafetyAlarm({
            cookie: sessionCookie,
            atExpires,
            cookieStoreId
        });

        await Logger.success('Session synced to Flow2API', {
            reason,
            email,
            action: syncPayload.action || null,
            baseUrl: effectiveBaseUrl,
            sessionExpiresAt,
            sessionStoreId: sessionContext?.storeId || null
        });

        return {
            success: true,
            lastSync,
            message: syncPayload.message || '同步成功'
        };
    } catch (error) {
        const waitingForSession = isWaitingSessionError(error);
        const lastSync = waitingForSession
            ? createWaitingSessionState(settings.lastSync, reason, error.message)
            : {
                status: 'error',
                reason,
                syncedAt: settings.lastSync?.syncedAt || null,
                checkedAt: new Date().toISOString(),
                email: settings.lastSync?.email || null,
                atExpires: settings.lastSync?.atExpires || null,
                sessionExpiresAt: settings.lastSync?.sessionExpiresAt || null,
                sessionFingerprint: settings.lastSync?.sessionFingerprint || null,
                action: null,
                message: error.message
            };

        await saveScopedSettings(cookieStoreId, { lastSync });
        await saveSessionScopedLastSync(lastSync);
        await (waitingForSession ? Logger.info : Logger.error).call(Logger, waitingForSession ? 'Waiting for Google Labs session' : 'Session sync failed', {
            reason,
            error: error.message,
            cookieStoreId: normalizeCookieStoreId(cookieStoreId) || null
        });

        if (waitingForSession) {
            await refreshSafetyAlarm();
        }

        if (waitingForSession && notifyOnError) {
            await createNotification(
                'Flow2API 正在等待当前 Profile 的 Labs 会话',
                buildProfileHintMessage({
                    baseUrl: effectiveBaseUrl,
                    email: settings.lastSync?.email || null,
                    fallback: lastSync.message || '扩展已后台尝试恢复；如果仍未恢复，会继续自动重试。'
                })
            );
        }

        if (notifyOnError && !waitingForSession) {
            await createNotification('Flow2API 同步失败', error.message);
        }

        return {
            success: false,
            error: waitingForSession ? lastSync.message : error.message,
            lastSync
        };
    }
}

async function hydrateConnectionFromConsole(baseUrl, {
    openIfMissing,
    activateOnNeedsLogin,
    preferredCookieStoreId = null,
    configCookieStoreId = null
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
        activateOnNeedsLogin,
        preferredCookieStoreId
    });

    if (!adminSession.success) {
        return adminSession;
    }

    const pluginConfig = await ensurePluginConfig(normalized.origin, adminSession.adminToken);
    const connectionToken = (pluginConfig.connectionToken || '').trim();

    if (!connectionToken) {
        throw new Error('无法从 Flow2API 控制台读取连接 Token');
    }

    const targetCookieStoreId = normalizeCookieStoreId(configCookieStoreId || preferredCookieStoreId);
    await saveScopedConfig(targetCookieStoreId, {
        baseUrl: normalized.origin,
        connectionToken
    });

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
    activateOnNeedsLogin,
    preferredCookieStoreId = null
}) {
    const candidates = await findConsoleTabs(baseUrl, preferredCookieStoreId);

    for (const tab of candidates) {
        const probe = await probeFlow2ApiTab(tab.id);

        if (probe?.adminToken) {
            await rememberConsoleContext({
                cookieStoreId: tab.cookieStoreId || preferredCookieStoreId || null
            });

            return {
                success: true,
                adminToken: probe.adminToken,
                tabId: tab.id,
                pageKind: probe.pageKind
            };
        }
    }

    const targetTab = candidates[0] || null;

    if (openIfMissing) {
        const { tab, created } = await findOrCreateTab(`${baseUrl}/manage`, {
            active: false,
            focusIfExisting: false,
            cookieStoreId: preferredCookieStoreId
        });

        try {
            await waitForTabLoad(tab.id);
        } catch (error) {
            if (created && !activateOnNeedsLogin) {
                await closeTabIfNeeded(tab.id);
            }

            throw error;
        }

        const probe = await waitForAdminSessionInTab(tab.id);
        if (probe?.adminToken) {
            await rememberConsoleContext({
                cookieStoreId: tab.cookieStoreId || preferredCookieStoreId || null
            });

            if (created) {
                await closeTabIfNeeded(tab.id);
            }

            return {
                success: true,
                adminToken: probe.adminToken,
                tabId: tab.id,
                pageKind: probe.pageKind
            };
        }

        if (!activateOnNeedsLogin && created) {
            await closeTabIfNeeded(tab.id);
        }

        if (activateOnNeedsLogin) {
            await focusTab(tab);

            return {
                success: false,
                needsLogin: true,
                openedConsole: true,
                message: '已打开 Flow2API 控制台，请先登录后台，然后再点一次“连接并同步”'
            };
        }
    }

    if (targetTab && activateOnNeedsLogin) {
        await focusTab(targetTab);
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
        throw createHttpError(configResponse, '读取插件连接配置失败');
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
        throw createHttpError(createResponse, '自动生成插件连接 Token 失败');
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
        throw createHttpError(response, '读取账号信息失败');
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
        throw createHttpError(response, '向 Flow2API 同步登录态失败');
    }

    if (response.data?.success === false) {
        throw createHttpError(response, response.data.message || 'Flow2API 返回了失败结果');
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

async function getSessionCookie({
    loadIfMissing,
    preferredContext = null
}) {
    let cookie = await findSessionCookie({ preferredContext });

    if (!cookie && loadIfMissing) {
        const wakeupStoreIds = await collectSessionWakeupStoreIds(preferredContext);
        const tabs = await openLabsWakeupTabs(wakeupStoreIds);

        try {
            await Promise.allSettled(tabs.map((tab) => waitForTabLoad(tab.id)));
            cookie = await waitForSessionCookieDiscovery({ preferredContext });

            if (!cookie && preferredContext) {
                cookie = await waitForSessionCookieDiscovery();
            }
        } finally {
            await Promise.allSettled(tabs.map((tab) => closeTabIfNeeded(tab.id)));
        }
    }

    return cookie;
}

async function resolveSessionCookie({
    baseUrl,
    adminToken = null,
    loadIfMissing,
    preferredContext = null
}) {
    const initialCandidates = await listSessionCookieCandidates({ preferredContext });
    const initialResolution = adminToken
        ? await pickUsableSessionCookie(initialCandidates, {
            baseUrl,
            adminToken
        })
        : {
            cookie: initialCandidates[0] || null,
            derivedAccount: null,
            invalidCandidates: []
        };

    if (initialResolution.cookie || !loadIfMissing) {
        return initialResolution;
    }

    const wakeupStoreIds = await collectSessionWakeupStoreIds(preferredContext);
    const tabs = await openLabsWakeupTabs(wakeupStoreIds);

    try {
        await Promise.allSettled(tabs.map((tab) => waitForTabLoad(tab.id)));
        const wokenCandidates = (await waitForSessionCookieCandidates({
            preferredContext,
            excludeIdentities: new Set(initialResolution.invalidCandidates)
        })) || [];
        const wakeResolution = adminToken
            ? await pickUsableSessionCookie(wokenCandidates, {
                baseUrl,
                adminToken
            })
            : {
                cookie: wokenCandidates[0] || null,
                derivedAccount: null,
                invalidCandidates: []
            };

        if (wakeResolution.cookie) {
            return wakeResolution;
        }
    } finally {
        await Promise.allSettled(tabs.map((tab) => closeTabIfNeeded(tab.id)));
    }

    return initialResolution;
}

async function findSessionCookie({
    logIfMissing = true,
    preferredContext = null
} = {}) {
    const candidates = await listSessionCookieCandidates({ preferredContext });
    const preferred = candidates[0] || null;

    if (!preferred && logIfMissing) {
        const storeIds = await collectCandidateCookieStoreIds();
        await Logger.info('Google Labs session cookie not found', {
            storeIds,
            checkedVariants: buildSessionCookieQueries(storeIds).length,
            preferredStoreId: preferredContext?.storeId || null
        });
    }

    return preferred;
}

async function listSessionCookieCandidates({
    preferredContext = null,
    excludeIdentities = null
} = {}) {
    const storeIds = await collectCandidateCookieStoreIds();
    const candidates = [];
    const seen = new Set();
    const excluded = excludeIdentities instanceof Set ? excludeIdentities : null;

    for (const details of buildSessionCookieQueries(storeIds)) {
        const cookies = await safeGetAllCookies(details);

        for (const cookie of cookies) {
            if (!cookie?.value) {
                continue;
            }

            const key = serializeCookieIdentity(cookie);
            if (seen.has(key) || (excluded && excluded.has(key))) {
                continue;
            }

            seen.add(key);
            candidates.push(cookie);
        }
    }

    return [...candidates]
        .sort((left, right) => compareSessionCookies(left, right, preferredContext))
        .filter((cookie) => cookie?.value);
}

async function openLabsTab({ cookieStoreId = null } = {}) {
    const details = {
        url: LABS_URL,
        active: false
    };

    if (cookieStoreId) {
        details.cookieStoreId = cookieStoreId;
    }

    try {
        return await extensionApi.tabs.create(details);
    } catch (error) {
        if (cookieStoreId) {
            await Logger.info('Labs wakeup skipped for unsupported cookie store', {
                cookieStoreId,
                error: error.message
            });
            return null;
        }

        throw error;
    }
}

async function openLabsWakeupTabs(storeIds) {
    const tabs = [];

    for (const storeId of storeIds) {
        const tab = await openLabsTab({ cookieStoreId: storeId });
        if (tab?.id) {
            tabs.push(tab);
        }
    }

    if (tabs.length === 0) {
        const fallbackTab = await openLabsTab();
        if (fallbackTab?.id) {
            tabs.push(fallbackTab);
        }
    }

    return tabs;
}

async function collectSessionWakeupStoreIds(preferredContext = null) {
    const discoveredStoreIds = await collectCandidateCookieStoreIds();
    const ordered = [];
    const seen = new Set();

    const pushStoreId = (storeId) => {
        const normalized = normalizeCookieStoreId(storeId);
        const key = normalized || '__default__';

        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        ordered.push(normalized);
    };

    pushStoreId(preferredContext?.storeId || null);

    for (const storeId of discoveredStoreIds) {
        pushStoreId(storeId);
    }

    if (ordered.length === 0) {
        pushStoreId(null);
    }

    return ordered.slice(0, MAX_BACKGROUND_WAKEUP_TABS);
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

async function refreshSafetyAlarm({
    cookie = null,
    atExpires = null,
    cookieStoreId = null
} = {}) {
    await extensionApi.alarms.clear(SYNC_ALARM_NAME);

    const configuredStoreIds = await collectConfiguredCookieStoreIds();
    if (configuredStoreIds.length === 0) {
        return;
    }

    const requestedCookieStoreId = normalizeCookieStoreId(cookieStoreId);
    const seenStoreKeys = new Set();
    const targetStoreIds = [];

    for (const currentCookieStoreId of [requestedCookieStoreId, ...configuredStoreIds]) {
        const storeKey = storeKeyFromCookieStoreId(currentCookieStoreId);
        if (seenStoreKeys.has(storeKey)) {
            continue;
        }

        seenStoreKeys.add(storeKey);
        targetStoreIds.push(currentCookieStoreId);
    }

    const now = Date.now();
    const fallbackAt = now + DEFAULT_SAFETY_SYNC_MINUTES * 60 * 1000;
    const scheduleCandidates = [];
    const scopeDiagnostics = [];

    for (const currentCookieStoreId of targetStoreIds) {
        const scopedSettings = await loadSettings({ cookieStoreId: currentCookieStoreId });
        if (!scopedSettings.baseUrl) {
            continue;
        }

        const preferredContext = scopedSettings.sessionContext || buildStoreSessionPreference(currentCookieStoreId);
        const currentCookie = cookie && normalizeCookieStoreId(cookie.storeId) === normalizeCookieStoreId(currentCookieStoreId)
            ? cookie
            : await findSessionCookie({ preferredContext, logIfMissing: false });

        let cookieRefreshAt = null;
        let cookieExpiryMs = null;
        if (currentCookie?.expirationDate) {
            cookieExpiryMs = currentCookie.expirationDate * 1000;
            const desired = cookieExpiryMs - EARLY_REFRESH_MS;
            const minimum = now + HEURISTIC_MEDIUM_PROBE_MS;
            cookieRefreshAt = Math.max(minimum, desired);
        }

        let accountRefreshAt = null;
        const effectiveAtExpires = normalizeCookieStoreId(currentCookieStoreId) === requestedCookieStoreId
            ? atExpires
            : null;
        const accountExpiryMs = parseDateSafe(effectiveAtExpires || scopedSettings.lastSync?.atExpires);
        if (accountExpiryMs) {
            const desired = accountExpiryMs - ACCESS_TOKEN_EARLY_REFRESH_MS;
            const minimum = now + ACCESS_TOKEN_MINIMUM_REFRESH_MS;
            accountRefreshAt = Math.max(minimum, desired);
        }

        const heuristicProbeAt = calculateHeuristicProbeAt({
            now,
            accountExpiryMs,
            cookieExpiryMs
        });

        if (accountRefreshAt) {
            scheduleCandidates.push(accountRefreshAt);
        }

        if (cookieRefreshAt) {
            scheduleCandidates.push(cookieRefreshAt);

            if (!accountRefreshAt) {
                scheduleCandidates.push(fallbackAt);
            }
        }

        if (heuristicProbeAt) {
            scheduleCandidates.push(heuristicProbeAt);
        }

        if (scopedSettings.lastSync?.status === 'waiting_session') {
            scheduleCandidates.push(now + WAITING_RETRY_MINUTES * 60 * 1000);
        }

        scopeDiagnostics.push({
            cookieStoreId: normalizeCookieStoreId(currentCookieStoreId) || null,
            accountExpiryAt: accountExpiryMs ? new Date(accountExpiryMs).toISOString() : null,
            cookieExpiryAt: cookieExpiryMs ? new Date(cookieExpiryMs).toISOString() : null,
            heuristicProbeAt: heuristicProbeAt ? new Date(heuristicProbeAt).toISOString() : null
        });
    }

    const when = scheduleCandidates.length > 0
        ? Math.min(...scheduleCandidates)
        : now + WAITING_RETRY_MINUTES * 60 * 1000;

    extensionApi.alarms.create(SYNC_ALARM_NAME, { when });

    await Logger.info('Safety sync scheduled', {
        scheduledAt: new Date(when).toISOString(),
        scopes: scopeDiagnostics
    });
}

async function handleLabsSessionRemoved(changeInfo, cookieStoreId = null) {
    await migrateLegacyConfig();

    await Logger.info('Google Labs session cookie removed', {
        cause: changeInfo.cause,
        cookieStoreId: normalizeCookieStoreId(cookieStoreId) || null
    });

    if (!await hasKnownStoreState(cookieStoreId)) {
        return;
    }

    const settings = await loadSettings({ cookieStoreId });
    if (!settings.connectionToken) {
        return;
    }

    const recovery = await syncCurrentSession({
        reason: 'cookie_removed_recovery',
        allowLabsWakeup: true,
        allowConsoleWakeup: true,
        notifyOnError: false,
        cookieStoreId
    });

    if (recovery.success) {
        return;
    }

    if (recovery.lastSync?.status === 'waiting_session') {
        await createNotification(
            'Flow2API 正在等待当前 Profile 的 Labs 会话',
            buildProfileHintMessage({
                baseUrl: settings.baseUrl,
                email: recovery.lastSync.email || settings.lastSync?.email || null,
                fallback: '扩展已后台尝试恢复，会继续自动重试。'
            })
        );
    }
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

async function waitForSessionCookieDiscovery({
    timeoutMs = SESSION_DISCOVERY_TIMEOUT_MS,
    preferredContext = null
} = {}) {
    return waitForValue(async () => findSessionCookie({
        logIfMissing: false,
        preferredContext
    }), {
        timeoutMs,
        intervalMs: SESSION_DISCOVERY_INTERVAL_MS
    });
}

async function waitForSessionCookieCandidates({
    timeoutMs = SESSION_DISCOVERY_TIMEOUT_MS,
    preferredContext = null,
    excludeIdentities = null
} = {}) {
    return waitForValue(async () => {
        const candidates = await listSessionCookieCandidates({
            preferredContext,
            excludeIdentities
        });
        return candidates.length > 0 ? candidates : null;
    }, {
        timeoutMs,
        intervalMs: SESSION_DISCOVERY_INTERVAL_MS
    });
}

async function waitForAdminSessionInTab(tabId, timeoutMs = CONSOLE_DISCOVERY_TIMEOUT_MS) {
    return waitForValue(async () => {
        const probe = await probeFlow2ApiTab(tabId);
        return probe?.adminToken ? probe : null;
    }, {
        timeoutMs,
        intervalMs: SESSION_DISCOVERY_INTERVAL_MS
    });
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

function pickPreferredSessionCookie(cookies, preferredContext = null) {
    if (!Array.isArray(cookies) || cookies.length === 0) {
        return null;
    }

    return [...cookies]
        .sort((left, right) => compareSessionCookies(left, right, preferredContext))
        .find((cookie) => cookie?.value) || null;
}

async function pickUsableSessionCookie(candidates, {
    baseUrl,
    adminToken
}) {
    const invalidCandidates = [];

    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const validation = await validateSessionCookieCandidate(candidate, {
            baseUrl,
            adminToken
        });

        if (validation.success) {
            return {
                cookie: candidate,
                derivedAccount: validation.derivedAccount,
                invalidCandidates
            };
        }

        if (validation.reason === 'invalid_session') {
            invalidCandidates.push(serializeCookieIdentity(candidate));
            await Logger.info('Ignoring stale Google Labs session cookie', {
                cookieStoreId: normalizeCookieStoreId(candidate.storeId) || null,
                sessionExpiresAt: formatCookieExpiry(candidate),
                reason: validation.error.message
            });
            continue;
        }

        return {
            cookie: candidate,
            derivedAccount: null,
            invalidCandidates
        };
    }

    return {
        cookie: null,
        derivedAccount: null,
        invalidCandidates
    };
}

async function validateSessionCookieCandidate(cookie, {
    baseUrl,
    adminToken
}) {
    if (!cookie?.value || !adminToken) {
        return {
            success: false,
            reason: 'validation_unavailable',
            derivedAccount: null
        };
    }

    try {
        return {
            success: true,
            reason: 'valid',
            derivedAccount: await convertSessionToken(baseUrl, adminToken, cookie.value)
        };
    } catch (error) {
        return {
            success: false,
            reason: isInvalidSessionTokenError(error) ? 'invalid_session' : 'validation_unavailable',
            error,
            derivedAccount: null
        };
    }
}

function compareSessionCookies(left, right, preferredContext) {
    const contextDelta = scoreSessionContextMatch(right, preferredContext) - scoreSessionContextMatch(left, preferredContext);
    if (contextDelta !== 0) {
        return contextDelta;
    }

    return scoreSessionCookie(right) - scoreSessionCookie(left);
}

function isInvalidSessionTokenError(error) {
    const message = `${error && error.message ? error.message : error || ''}`.toLowerCase();
    return /\b(400|401|403)\b/.test(message)
        || message.includes('expired')
        || message.includes('invalid')
        || message.includes('unauthorized')
        || message.includes('forbidden')
        || message.includes('过期')
        || message.includes('失效')
        || message.includes('无效')
        || message.includes('未授权');
}

function scoreSessionContextMatch(cookie, preferredContext) {
    if (!preferredContext || !cookie) {
        return 0;
    }

    if (doesCookieMatchContext(cookie, preferredContext)) {
        return 4;
    }

    if (normalizeCookieStoreId(cookie.storeId) && normalizeCookieStoreId(cookie.storeId) === preferredContext.storeId) {
        return 3;
    }

    if (cookie.partitionKey?.topLevelSite && cookie.partitionKey.topLevelSite === preferredContext.partitionTopLevelSite) {
        return 2;
    }

    if ((cookie.firstPartyDomain || null) === preferredContext.firstPartyDomain) {
        return 1;
    }

    return 0;
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

async function findConsoleTabs(baseUrl, preferredCookieStoreId = null) {
    try {
        const tabs = await extensionApi.tabs.query({});

        return tabs
            .filter((tab) => isFlow2ApiConsoleUrl(tab.url, baseUrl))
            .sort((left, right) => scoreConsoleTab(right, preferredCookieStoreId) - scoreConsoleTab(left, preferredCookieStoreId));
    } catch (error) {
        await Logger.info('Failed to enumerate Flow2API tabs', {
            error: error.message
        });
        return [];
    }
}

function isFlow2ApiConsoleUrl(rawUrl, baseUrl) {
    if (!rawUrl) {
        return false;
    }

    try {
        const url = new URL(rawUrl);
        if (url.origin !== baseUrl) {
            return false;
        }

        return url.pathname.startsWith('/manage') || url.pathname.startsWith('/login');
    } catch (error) {
        return false;
    }
}

function scoreConsoleTab(tab, preferredCookieStoreId = null) {
    try {
        const url = new URL(tab.url);
        let score = tab.active ? 2 : 1;

        if (url.pathname.startsWith('/manage')) {
            score += 4;
        } else if (url.pathname.startsWith('/login')) {
            score += 3;
        }

        if (preferredCookieStoreId && normalizeCookieStoreId(tab.cookieStoreId) === normalizeCookieStoreId(preferredCookieStoreId)) {
            score += 6;
        }

        return score;
    } catch (error) {
        return 0;
    }
}

async function probeFlow2ApiTab(tabId) {
    let result;

    try {
        result = await executeInTab(tabId, function probePageContext() {
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
    } catch (error) {
        if (isMissingHostPermissionError(error)) {
            await Logger.info('Flow2API tab probe skipped because host permission is missing', {
                tabId,
                error: error.message
            });
            return null;
        }

        throw error;
    }

    return result || null;
}

function isMissingHostPermissionError(error) {
    const message = `${error && error.message ? error.message : error || ''}`;
    return /Missing host permission for the tab/i.test(message);
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

async function findOrCreateTab(url, {
    active,
    focusIfExisting,
    cookieStoreId = null
}) {
    const tabs = await extensionApi.tabs.query({});
    const normalizedStoreId = normalizeCookieStoreId(cookieStoreId);
    const existing = tabs.find((tab) => {
        if (tab.url !== url) {
            return false;
        }

        if (!normalizedStoreId) {
            return true;
        }

        return normalizeCookieStoreId(tab.cookieStoreId) === normalizedStoreId;
    }) || null;

    if (existing) {
        if (active && focusIfExisting) {
            await focusTab(existing);
        }

        return {
            tab: existing,
            created: false
        };
    }

    const createDetails = { url, active };
    if (normalizedStoreId) {
        createDetails.cookieStoreId = normalizedStoreId;
    }

    try {
        return {
            tab: await extensionApi.tabs.create(createDetails),
            created: true
        };
    } catch (error) {
        if (normalizedStoreId) {
            delete createDetails.cookieStoreId;

            return {
                tab: await extensionApi.tabs.create(createDetails),
                created: true
            };
        }

        throw error;
    }
}

async function focusTab(tab) {
    if (!tab?.id) {
        return;
    }

    await extensionApi.tabs.update(tab.id, { active: true });

    if (typeof tab.windowId === 'number' && extensionApi.windows?.update) {
        await extensionApi.windows.update(tab.windowId, { focused: true });
    }
}

async function focusOrCreateTab(url, cookieStoreId = null) {
    const { tab } = await findOrCreateTab(url, {
        active: true,
        focusIfExisting: true,
        cookieStoreId
    });

    return tab;
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

async function loadSettings({ cookieStoreId = null } = {}) {
    const scopedState = await loadStoreScopedState();
    const storeKey = storeKeyFromCookieStoreId(cookieStoreId);
    const scopedConfig = scopedState.configByStore[storeKey] || null;
    const sharedConfig = scopedConfig
        ? null
        : resolveSharedConfigCandidate(scopedState.configByStore);
    const effectiveConfig = scopedConfig || sharedConfig || null;

    return {
        baseUrl: effectiveConfig?.baseUrl || '',
        connectionToken: effectiveConfig?.connectionToken || '',
        lastSync: scopedState.lastSyncByStore[storeKey] || null,
        sessionContext: scopedState.sessionContextByStore[storeKey] || null,
        consoleContext: scopedState.consoleContextByStore[storeKey] || null,
        configSource: scopedConfig
            ? 'local'
            : (sharedConfig ? 'shared' : 'none')
    };
}

async function loadStoreScopedState() {
    const stored = await extensionApi.storage.local.get([
        CONFIG_BY_STORE_KEY,
        'lastSync',
        'sessionContext',
        'consoleContext',
        LAST_SYNC_BY_STORE_KEY,
        SESSION_CONTEXT_BY_STORE_KEY,
        CONSOLE_CONTEXT_BY_STORE_KEY
    ]);

    const configByStore = normalizeStoreScopedMap(stored[CONFIG_BY_STORE_KEY], normalizeScopedConfig);
    const lastSyncByStore = normalizeStoreScopedMap(stored[LAST_SYNC_BY_STORE_KEY], normalizeLastSyncValue);
    const sessionContextByStore = normalizeStoreScopedMap(stored[SESSION_CONTEXT_BY_STORE_KEY], normalizeSessionContext);
    const consoleContextByStore = normalizeStoreScopedMap(stored[CONSOLE_CONTEXT_BY_STORE_KEY], normalizeConsoleContext);

    const legacyLastSync = normalizeLastSyncValue(stored.lastSync);
    const legacySessionContext = normalizeSessionContext(stored.sessionContext);
    const legacyConsoleContext = normalizeConsoleContext(stored.consoleContext);
    const legacyStoreKey = storeKeyFromCookieStoreId(legacySessionContext?.storeId || legacyConsoleContext?.cookieStoreId || null);

    if (legacyLastSync && !lastSyncByStore[legacyStoreKey]) {
        lastSyncByStore[legacyStoreKey] = legacyLastSync;
    }

    if (legacySessionContext && !sessionContextByStore[legacyStoreKey]) {
        sessionContextByStore[legacyStoreKey] = legacySessionContext;
    }

    if (legacyConsoleContext && !consoleContextByStore[legacyStoreKey]) {
        consoleContextByStore[legacyStoreKey] = legacyConsoleContext;
    }

    return {
        configByStore,
        lastSyncByStore,
        sessionContextByStore,
        consoleContextByStore
    };
}

async function loadSessionScopedLastSyncMap() {
    const stored = await extensionApi.storage.local.get([
        LAST_SYNC_BY_SESSION_KEY
    ]);

    return normalizeSessionScopedMap(stored[LAST_SYNC_BY_SESSION_KEY], normalizeLastSyncValue);
}

function normalizeStoreScopedMap(value, normalizer) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(value)
            .map(([storeKey, entry]) => [storeKeyFromCookieStoreId(cookieStoreIdFromStoreKey(storeKey)), normalizer(entry)])
            .filter(([, entry]) => Boolean(entry))
    );
}

function normalizeSessionScopedMap(value, normalizer) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(value)
            .map(([sessionFingerprint, entry]) => [normalizeSessionFingerprint(sessionFingerprint), normalizer(entry)])
            .filter(([sessionFingerprint, entry]) => Boolean(sessionFingerprint && entry))
    );
}

function normalizeLastSyncValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeSessionFingerprint(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function fingerprintSessionToken(sessionToken) {
    if (typeof sessionToken !== 'string' || !sessionToken) {
        return '';
    }

    let hash = 2166136261;
    for (let index = 0; index < sessionToken.length; index += 1) {
        hash ^= sessionToken.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return `st_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function saveSessionScopedLastSync(lastSync) {
    const normalizedLastSync = normalizeLastSyncValue(lastSync);
    const sessionFingerprint = normalizeSessionFingerprint(normalizedLastSync?.sessionFingerprint);
    if (!normalizedLastSync || !sessionFingerprint) {
        return;
    }

    const lastSyncBySession = await loadSessionScopedLastSyncMap();
    lastSyncBySession[sessionFingerprint] = normalizedLastSync;

    await extensionApi.storage.local.set({
        [LAST_SYNC_BY_SESSION_KEY]: lastSyncBySession
    });
}

function selectDisplayedLastSync(storedLastSync, currentSessionState) {
    if (!currentSessionState?.sessionFingerprint) {
        return storedLastSync;
    }

    if (currentSessionState.lastSync) {
        return currentSessionState.lastSync;
    }

    if (storedLastSync?.sessionFingerprint === currentSessionState.sessionFingerprint) {
        return storedLastSync;
    }

    return currentSessionState.previewLastSync || null;
}

async function detectCurrentSessionState({
    cookieStoreId = null,
    settings = null
} = {}) {
    const effectiveSettings = settings || await loadSettings({ cookieStoreId });
    const preferredContext = effectiveSettings.sessionContext || buildStoreSessionPreference(cookieStoreId);

    let sessionCookie = await findSessionCookie({
        preferredContext,
        logIfMissing: false
    });

    if (!sessionCookie && preferredContext) {
        sessionCookie = await findSessionCookie({
            preferredContext: null,
            logIfMissing: false
        });
    }

    const sessionFingerprint = fingerprintSessionToken(sessionCookie?.value || '');
    if (!sessionCookie?.value || !sessionFingerprint) {
        return {
            sessionFingerprint: '',
            lastSync: null,
            previewLastSync: null
        };
    }

    const lastSyncBySession = await loadSessionScopedLastSyncMap();
    const sessionLastSync = lastSyncBySession[sessionFingerprint] || null;
    if (sessionLastSync) {
        return {
            sessionFingerprint,
            lastSync: sessionLastSync,
            previewLastSync: null
        };
    }

    let derivedAccount = null;
    if (effectiveSettings.baseUrl && await hasOriginPermission(effectiveSettings.baseUrl)) {
        const preferredCookieStoreId = effectiveSettings.consoleContext?.cookieStoreId
            || normalizeCookieStoreId(cookieStoreId)
            || effectiveSettings.sessionContext?.storeId
            || normalizeCookieStoreId(sessionCookie.storeId)
            || null;
        const adminSession = await getAdminSessionFromConsole(effectiveSettings.baseUrl, {
            openIfMissing: false,
            activateOnNeedsLogin: false,
            preferredCookieStoreId
        });

        if (adminSession.success) {
            try {
                derivedAccount = await convertSessionToken(
                    effectiveSettings.baseUrl,
                    adminSession.adminToken,
                    sessionCookie.value
                );
            } catch (error) {
                await Logger.info('Current session preview skipped', {
                    reason: error.message
                });
            }
        }
    }

    return {
        sessionFingerprint,
        lastSync: null,
        previewLastSync: {
            status: 'detected_session',
            reason: 'detected_session',
            syncedAt: null,
            checkedAt: new Date().toISOString(),
            email: derivedAccount?.email || null,
            atExpires: derivedAccount?.expires || null,
            sessionExpiresAt: formatCookieExpiry(sessionCookie),
            sessionFingerprint,
            action: null,
            message: derivedAccount?.email
                ? '检测到当前账号尚未同步，点一下即可把这个账号同步到 Flow2API。'
                : '检测到当前 Google Labs 会话，点一下即可把这个账号同步到 Flow2API。'
        }
    };
}

function normalizeScopedConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    let baseUrl = '';
    if (typeof value.baseUrl === 'string' && value.baseUrl.trim()) {
        try {
            baseUrl = normalizeBaseUrl(value.baseUrl).origin;
        } catch (error) {
            baseUrl = '';
        }
    }

    const connectionToken = typeof value.connectionToken === 'string'
        ? value.connectionToken.trim()
        : '';

    if (!baseUrl && !connectionToken) {
        return null;
    }

    return {
        baseUrl,
        connectionToken
    };
}

function serializeScopedConfigIdentity(config) {
    const normalized = normalizeScopedConfig(config);
    if (!normalized) {
        return '';
    }

    return JSON.stringify([
        normalized.baseUrl,
        normalized.connectionToken
    ]);
}

function resolveSharedConfigCandidate(configByStore) {
    if (!configByStore || typeof configByStore !== 'object' || Array.isArray(configByStore)) {
        return null;
    }

    const normalizedConfigs = Object.values(configByStore)
        .map((config) => normalizeScopedConfig(config))
        .filter((config) => Boolean(config));

    if (normalizedConfigs.length === 0) {
        return null;
    }

    const identities = new Set(
        normalizedConfigs
            .map((config) => serializeScopedConfigIdentity(config))
            .filter((identity) => Boolean(identity))
    );

    if (identities.size !== 1) {
        return null;
    }

    return normalizedConfigs[0];
}

async function saveScopedConfig(cookieStoreId, {
    baseUrl = UNSET_VALUE,
    connectionToken = UNSET_VALUE
} = {}) {
    const scopedState = await loadStoreScopedState();
    const storeKey = storeKeyFromCookieStoreId(cookieStoreId);
    const existingConfig = scopedState.configByStore[storeKey] || {
        baseUrl: '',
        connectionToken: ''
    };
    const nextConfig = {
        ...existingConfig
    };

    if (baseUrl !== UNSET_VALUE) {
        if (typeof baseUrl === 'string' && baseUrl.trim()) {
            nextConfig.baseUrl = normalizeBaseUrl(baseUrl).origin;
        } else {
            nextConfig.baseUrl = '';
        }
    }

    if (connectionToken !== UNSET_VALUE) {
        nextConfig.connectionToken = typeof connectionToken === 'string'
            ? connectionToken.trim()
            : '';
    }

    const normalizedConfig = normalizeScopedConfig(nextConfig);
    if (normalizedConfig) {
        scopedState.configByStore[storeKey] = normalizedConfig;
    } else {
        delete scopedState.configByStore[storeKey];
    }

    await extensionApi.storage.local.set({
        [CONFIG_BY_STORE_KEY]: scopedState.configByStore
    });
}

async function saveScopedSettings(cookieStoreId, {
    lastSync = UNSET_VALUE,
    sessionContext = UNSET_VALUE,
    consoleContext = UNSET_VALUE
} = {}) {
    const scopedState = await loadStoreScopedState();
    const storeKey = storeKeyFromCookieStoreId(cookieStoreId);
    const payload = {};

    if (lastSync !== UNSET_VALUE) {
        const normalizedLastSync = normalizeLastSyncValue(lastSync);
        if (normalizedLastSync) {
            scopedState.lastSyncByStore[storeKey] = normalizedLastSync;
        } else {
            delete scopedState.lastSyncByStore[storeKey];
        }

        payload.lastSync = normalizedLastSync;
        payload[LAST_SYNC_BY_STORE_KEY] = scopedState.lastSyncByStore;
    }

    if (sessionContext !== UNSET_VALUE) {
        const normalizedSessionContext = normalizeSessionContext(sessionContext);
        if (normalizedSessionContext) {
            scopedState.sessionContextByStore[storeKey] = normalizedSessionContext;
        } else {
            delete scopedState.sessionContextByStore[storeKey];
        }

        payload.sessionContext = normalizedSessionContext;
        payload[SESSION_CONTEXT_BY_STORE_KEY] = scopedState.sessionContextByStore;
    }

    if (consoleContext !== UNSET_VALUE) {
        const normalizedConsoleContext = normalizeConsoleContext(consoleContext);
        if (normalizedConsoleContext) {
            scopedState.consoleContextByStore[storeKey] = normalizedConsoleContext;
        } else {
            delete scopedState.consoleContextByStore[storeKey];
        }

        payload.consoleContext = normalizedConsoleContext;
        payload[CONSOLE_CONTEXT_BY_STORE_KEY] = scopedState.consoleContextByStore;
    }

    if (Object.keys(payload).length > 0) {
        await extensionApi.storage.local.set(payload);
    }
}

async function collectConfiguredCookieStoreIds() {
    const scopedState = await loadStoreScopedState();
    const storeKeys = new Set(
        Object.entries(scopedState.configByStore)
            .filter(([, config]) => Boolean(config?.baseUrl))
            .map(([storeKey]) => storeKey)
    );
    const sharedConfig = resolveSharedConfigCandidate(scopedState.configByStore);

    if (sharedConfig?.baseUrl) {
        for (const storeKey of Object.keys(scopedState.lastSyncByStore)) {
            storeKeys.add(storeKey);
        }

        for (const storeKey of Object.keys(scopedState.sessionContextByStore)) {
            storeKeys.add(storeKey);
        }

        for (const storeKey of Object.keys(scopedState.consoleContextByStore)) {
            storeKeys.add(storeKey);
        }
    }

    return [...storeKeys].map(cookieStoreIdFromStoreKey);
}

async function hasKnownStoreState(cookieStoreId, scopedState = null) {
    const effectiveScopedState = scopedState || await loadStoreScopedState();
    const storeKey = storeKeyFromCookieStoreId(cookieStoreId);

    return Boolean(
        effectiveScopedState.configByStore[storeKey]?.baseUrl
        || effectiveScopedState.lastSyncByStore[storeKey]
        || effectiveScopedState.sessionContextByStore[storeKey]
        || effectiveScopedState.consoleContextByStore[storeKey]
    );
}

async function migrateLegacyConfig() {
    const localStored = await extensionApi.storage.local.get([
        CONFIG_BY_STORE_KEY,
        'baseUrl',
        'connectionToken',
        'apiUrl',
        ACCOUNT_SECRETS_KEY
    ]);
    const scopedState = await loadStoreScopedState();
    const hasScopedConfig = Object.keys(scopedState.configByStore).length > 0;

    let legacyBaseUrl = typeof localStored.baseUrl === 'string' ? localStored.baseUrl.trim() : '';
    let legacyApiUrl = typeof localStored.apiUrl === 'string' ? localStored.apiUrl.trim() : '';
    let legacyConnectionToken = typeof localStored.connectionToken === 'string'
        ? localStored.connectionToken.trim()
        : '';

    const localSecrets = normalizeSecretsMap(localStored[ACCOUNT_SECRETS_KEY]);
    const canReuseLegacySync = Object.keys(localSecrets).length > 0;
    const syncStored = canReuseLegacySync
        ? await safeGetSyncStorage(['accounts', 'apiUrl', 'connectionToken'])
        : {};

    if ((!legacyBaseUrl && !legacyApiUrl) || !legacyConnectionToken) {
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

    if (((!legacyBaseUrl && !legacyApiUrl) || !legacyConnectionToken) && syncStored.apiUrl && syncStored.connectionToken) {
        if (!legacyBaseUrl && !legacyApiUrl) {
            legacyApiUrl = syncStored.apiUrl.trim();
        }

        if (!legacyConnectionToken) {
            legacyConnectionToken = syncStored.connectionToken.trim();
        }
    }

    if (legacyBaseUrl) {
        legacyBaseUrl = normalizeBaseUrl(legacyBaseUrl).origin;
    }

    if (!legacyBaseUrl && legacyApiUrl) {
        legacyBaseUrl = normalizeBaseUrl(legacyApiUrl).origin;
    }

    const hasLegacyConfig = Boolean(legacyBaseUrl || legacyConnectionToken);
    const hasLegacyLocalKeys = [
        localStored.baseUrl,
        localStored.connectionToken,
        localStored.apiUrl
    ].some((value) => value !== undefined);

    if (!hasLegacyConfig) {
        if (hasLegacyLocalKeys) {
            await extensionApi.storage.local.remove(['baseUrl', 'connectionToken', 'apiUrl']);
        }
        return false;
    }

    if (hasScopedConfig) {
        if (hasLegacyLocalKeys) {
            await extensionApi.storage.local.remove(['baseUrl', 'connectionToken', 'apiUrl']);
        }
        return false;
    }

    const targetStoreIds = await collectLegacyConfigTargetStoreIds(scopedState);
    const configByStore = { ...scopedState.configByStore };

    for (const targetCookieStoreId of targetStoreIds) {
        configByStore[storeKeyFromCookieStoreId(targetCookieStoreId)] = {
            baseUrl: legacyBaseUrl,
            connectionToken: legacyConnectionToken
        };
    }

    await extensionApi.storage.local.set({
        [CONFIG_BY_STORE_KEY]: configByStore
    });
    await extensionApi.storage.local.remove(['baseUrl', 'connectionToken', 'apiUrl']);

    await Logger.info('Legacy config migrated to per-store Flow2API config model', {
        baseUrl: legacyBaseUrl,
        stores: targetStoreIds.map((cookieStoreId) => normalizeCookieStoreId(cookieStoreId) || null)
    });

    return true;
}

async function collectLegacyConfigTargetStoreIds(scopedState = null) {
    const effectiveScopedState = scopedState || await loadStoreScopedState();
    const storeKeys = new Set([
        ...Object.keys(effectiveScopedState.lastSyncByStore),
        ...Object.keys(effectiveScopedState.sessionContextByStore),
        ...Object.keys(effectiveScopedState.consoleContextByStore)
    ]);

    for (const cookieStoreId of await collectCandidateCookieStoreIds()) {
        if (!cookieStoreId && storeKeys.size > 0) {
            continue;
        }

        storeKeys.add(storeKeyFromCookieStoreId(cookieStoreId));
    }

    if (storeKeys.size === 0) {
        storeKeys.add(DEFAULT_STORE_KEY);
    }

    return [...storeKeys].map(cookieStoreIdFromStoreKey);
}

async function safeGetSyncStorage(keys) {
    try {
        return await extensionApi.storage.sync.get(keys);
    } catch (error) {
        return {};
    }
}

async function clearLegacySharedConfig() {
    if (!extensionApi.storage?.sync?.remove) {
        return false;
    }

    try {
        const synced = await safeGetSyncStorage(LEGACY_SYNC_CONFIG_KEYS);
        const keysToRemove = LEGACY_SYNC_CONFIG_KEYS.filter((key) => synced[key] !== undefined);

        if (keysToRemove.length === 0) {
            return false;
        }

        await extensionApi.storage.sync.remove(keysToRemove);
        await Logger.info('Cleared legacy cross-profile sync config', {
            keys: keysToRemove
        });
        return true;
    } catch (error) {
        await Logger.info('Legacy shared config cleanup skipped', {
            error: error.message
        });
        return false;
    }
}

function createHttpError(result, fallbackMessage) {
    const error = new Error(readHttpError(result, fallbackMessage));
    error.httpStatus = result.response?.status || null;
    error.responseData = result.data ?? null;
    return error;
}

async function pushSessionTokenWithRecovery({
    baseUrl,
    connectionToken,
    sessionToken,
    allowConsoleWakeup,
    preferredCookieStoreId = null
}) {
    try {
        return {
            payload: await pushSessionToken(baseUrl, connectionToken, sessionToken),
            connectionToken,
            adminToken: null
        };
    } catch (error) {
        if (!allowConsoleWakeup || !shouldRetryConnectionHydration(error)) {
            throw error;
        }

        await Logger.info('Flow2API connection token rejected, retrying console hydration', {
            baseUrl,
            status: error.httpStatus || null
        });

        const recovered = await hydrateConnectionFromConsole(baseUrl, {
            openIfMissing: true,
            activateOnNeedsLogin: false,
            preferredCookieStoreId,
            configCookieStoreId: preferredCookieStoreId
        });

        if (!recovered.success || !recovered.connectionToken) {
            throw error;
        }

        return {
            payload: await pushSessionToken(baseUrl, recovered.connectionToken, sessionToken),
            connectionToken: recovered.connectionToken,
            adminToken: recovered.adminToken || null
        };
    }
}

function shouldRetryConnectionHydration(error) {
    const status = error?.httpStatus;
    if (status === 401 || status === 403) {
        return true;
    }

    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
    return message.includes('connection token') || message.includes('连接 token');
}

function captureSessionContext(cookie) {
    if (!cookie) {
        return null;
    }

    return normalizeSessionContext({
        storeId: cookie.storeId || null,
        firstPartyDomain: cookie.firstPartyDomain || null,
        partitionTopLevelSite: cookie.partitionKey?.topLevelSite || null,
        domain: `${cookie.domain || ''}`.replace(/^\./, '') || null,
        path: cookie.path || '/',
        name: cookie.name || SESSION_COOKIE_NAME
    });
}

function normalizeSessionContext(context) {
    if (!context || typeof context !== 'object') {
        return null;
    }

    return {
        storeId: normalizeCookieStoreId(context.storeId),
        firstPartyDomain: typeof context.firstPartyDomain === 'string' ? context.firstPartyDomain : null,
        partitionTopLevelSite: typeof context.partitionTopLevelSite === 'string' ? context.partitionTopLevelSite : null,
        domain: typeof context.domain === 'string' && context.domain.trim()
            ? context.domain.replace(/^\./, '').trim()
            : 'labs.google',
        path: typeof context.path === 'string' && context.path.trim() ? context.path : '/',
        name: typeof context.name === 'string' && context.name.trim() ? context.name : SESSION_COOKIE_NAME
    };
}

function normalizeConsoleContext(context) {
    if (!context || typeof context !== 'object') {
        return null;
    }

    const cookieStoreId = normalizeCookieStoreId(context.cookieStoreId);
    if (!cookieStoreId) {
        return null;
    }

    return { cookieStoreId };
}

async function rememberConsoleContext(context, cookieStoreId = null) {
    const targetCookieStoreId = normalizeCookieStoreId(cookieStoreId || context?.cookieStoreId || null);
    const normalized = normalizeConsoleContext({
        cookieStoreId: targetCookieStoreId
    });

    if (!normalized) {
        return;
    }

    await saveScopedSettings(targetCookieStoreId, {
        consoleContext: normalized
    });
}

function doesCookieMatchContext(cookie, preferredContext) {
    const normalized = normalizeSessionContext(preferredContext);
    if (!cookie || !normalized) {
        return false;
    }

    if (normalizeCookieStoreId(cookie.storeId) !== normalized.storeId) {
        return false;
    }

    if ((cookie.firstPartyDomain || null) !== normalized.firstPartyDomain) {
        return false;
    }

    if ((cookie.partitionKey?.topLevelSite || null) !== normalized.partitionTopLevelSite) {
        return false;
    }

    const domain = `${cookie.domain || ''}`.replace(/^\./, '');
    return domain === normalized.domain
        && (cookie.path || '/') === normalized.path
        && (cookie.name || SESSION_COOKIE_NAME) === normalized.name;
}

function normalizeCookieStoreId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function storeKeyFromCookieStoreId(cookieStoreId) {
    return normalizeCookieStoreId(cookieStoreId) || DEFAULT_STORE_KEY;
}

function cookieStoreIdFromStoreKey(storeKey) {
    return storeKey === DEFAULT_STORE_KEY
        ? null
        : normalizeCookieStoreId(storeKey);
}

function buildStoreSessionPreference(cookieStoreId) {
    const normalized = normalizeCookieStoreId(cookieStoreId);
    if (!normalized) {
        return null;
    }

    return normalizeSessionContext({
        storeId: normalized,
        domain: 'labs.google',
        path: '/',
        name: SESSION_COOKIE_NAME
    });
}

function calculateHeuristicProbeAt({
    now,
    accountExpiryMs,
    cookieExpiryMs
}) {
    const upcoming = [accountExpiryMs, cookieExpiryMs]
        .filter((value) => Number.isFinite(value) && value > now)
        .sort((left, right) => left - right);

    if (upcoming.length === 0) {
        return null;
    }

    const remainingMs = upcoming[0] - now;
    let divisor = accountExpiryMs ? 3 : 4;
    let minimumInterval = HEURISTIC_MEDIUM_PROBE_MS;
    let maximumInterval = HEURISTIC_MAX_PROBE_MS;

    if (remainingMs <= 30 * 60 * 1000) {
        divisor = 4;
        minimumInterval = ACCESS_TOKEN_MINIMUM_REFRESH_MS;
        maximumInterval = HEURISTIC_FAST_PROBE_MS;
    } else if (remainingMs <= 2 * 60 * 60 * 1000) {
        divisor = 4;
        minimumInterval = HEURISTIC_FAST_PROBE_MS;
        maximumInterval = 30 * 60 * 1000;
    } else if (remainingMs <= 12 * 60 * 60 * 1000) {
        divisor = 4;
        minimumInterval = HEURISTIC_MEDIUM_PROBE_MS;
        maximumInterval = 2 * 60 * 60 * 1000;
    } else if (remainingMs <= 48 * 60 * 60 * 1000) {
        divisor = 3;
        minimumInterval = 30 * 60 * 1000;
        maximumInterval = 6 * 60 * 60 * 1000;
    } else {
        divisor = accountExpiryMs ? 3 : 4;
        minimumInterval = HEURISTIC_SLOW_PROBE_MS;
        maximumInterval = HEURISTIC_MAX_PROBE_MS;
    }

    const interval = clampNumber(Math.floor(remainingMs / divisor), minimumInterval, maximumInterval);
    return now + interval;
}

function clampNumber(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

async function handleTrackedSessionCookieChange(changeInfo) {
    const cookieStoreId = normalizeCookieStoreId(changeInfo.cookie?.storeId || null);

    if (changeInfo.removed) {
        const settings = await loadSettings({ cookieStoreId });
        if (settings.sessionContext && !doesCookieMatchContext(changeInfo.cookie, settings.sessionContext)) {
            return;
        }

        await handleLabsSessionRemoved(changeInfo, cookieStoreId);
        return;
    }

    await syncCurrentSession({
        reason: 'cookie_changed',
        allowLabsWakeup: false,
        allowConsoleWakeup: true,
        notifyOnError: true,
        cookieStoreId
    });
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

function isWaitingSessionError(errorOrMessage) {
    return isMissingLabsSessionError(errorOrMessage)
        || errorOrMessage?.message === PRESERVE_EXISTING_TOKEN_MESSAGE
        || errorOrMessage === PRESERVE_EXISTING_TOKEN_MESSAGE;
}

function shouldPreserveExistingToken(previousLastSync, reason) {
    if (reason === 'manual_sync' || reason === 'manual_connect') {
        return false;
    }

    if (previousLastSync?.status !== 'success') {
        return false;
    }

    const knownExpiryMs = parseDateSafe(previousLastSync.atExpires);
    return Number.isFinite(knownExpiryMs) && knownExpiryMs > Date.now() + ACCESS_TOKEN_MINIMUM_REFRESH_MS;
}

function createWaitingSessionState(previousLastSync, reason, message = WAITING_FOR_LABS_MESSAGE) {
    return {
        status: 'waiting_session',
        reason,
        syncedAt: previousLastSync?.syncedAt || null,
        checkedAt: new Date().toISOString(),
        email: previousLastSync?.email || null,
        atExpires: previousLastSync?.atExpires || null,
        sessionExpiresAt: previousLastSync?.sessionExpiresAt || null,
        sessionFingerprint: previousLastSync?.sessionFingerprint || null,
        action: null,
        message
    };
}

function formatCookieExpiry(cookie) {
    if (!cookie?.expirationDate) {
        return null;
    }

    return new Date(cookie.expirationDate * 1000).toISOString();
}

function parseDateSafe(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractEmail(message) {
    if (typeof message !== 'string') {
        return null;
    }

    const match = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : null;
}

function buildProfileHintMessage({
    baseUrl,
    email,
    fallback
}) {
    const parts = [];

    if (email) {
        parts.push(`账号：${email}`);
    }

    if (baseUrl) {
        parts.push(`Flow2API：${baseUrl}`);
    }

    parts.push(fallback);
    return parts.join('，');
}

async function waitForValue(check, {
    timeoutMs,
    intervalMs
}) {
    const start = Date.now();

    while (Date.now() - start <= timeoutMs) {
        const value = await check();
        if (value) {
            return value;
        }

        if (Date.now() - start >= timeoutMs) {
            break;
        }

        await sleep(intervalMs);
    }

    return null;
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
