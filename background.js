const extensionApi = globalThis.browser ?? globalThis.chrome;

const ALARM_NAME = 'tokenRefresh';
const LABS_URL = 'https://labs.google/fx/vi/tools/flow';
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const DEFAULT_REFRESH_INTERVAL = 60;
const SESSION_WAIT_MS = 5000;
const ACCOUNT_SECRETS_KEY = 'accountSecrets';

const Logger = {
    async log(level, message, details = null) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            details
        };

        console.log(`[${level}] ${message}`, details || '');

        const { logs = [] } = await extensionApi.storage.local.get(['logs']);
        logs.unshift(logEntry);

        if (logs.length > 80) {
            logs.splice(80);
        }

        await extensionApi.storage.local.set({ logs });
    },

    info(message, details) {
        return this.log('INFO', message, details);
    },

    error(message, details) {
        return this.log('ERROR', message, details);
    },

    success(message, details) {
        return this.log('SUCCESS', message, details);
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
    await setupAlarm();
});

if (extensionApi.runtime.onStartup) {
    extensionApi.runtime.onStartup.addListener(async () => {
        await migrateLegacyConfig();
        await setupAlarm();
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

extensionApi.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) {
        return;
    }

    await Logger.info('Alarm triggered, syncing all configured accounts...');

    const summary = await syncAllAccounts();
    await notifySummary(summary);
});

async function handleMessage(request) {
    switch (request.action) {
        case 'getSetupData':
            return getSetupData();
        case 'saveSettings':
            return saveSettings(request.settings);
        case 'testNow':
            if (request.account) {
                return extractAndSendToken(normalizeAccount(request.account, 0));
            }

            return testFirstAccount();
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

    return {
        success: true,
        settings: await loadSettings(),
        storeOptions: await listCookieStoreOptions(),
        browserInfo: await getBrowserInfoSafe()
    };
}

async function saveSettings(settings) {
    const normalizedSettings = validateAndNormalizeSettings(settings);
    const { syncSettings, localSettings } = splitSettingsForStorage(normalizedSettings);

    await extensionApi.storage.sync.set(syncSettings);
    await extensionApi.storage.local.set(localSettings);
    await extensionApi.storage.sync.remove(['apiUrl', 'connectionToken']);

    await setupAlarm();
    await Logger.info('Config updated', {
        accounts: normalizedSettings.accounts.map((account) => ({
            id: account.id,
            name: account.name,
            syncSource: account.syncSource,
            cookieStoreId: account.cookieStoreId || null
        })),
        refreshInterval: normalizedSettings.refreshInterval
    });

    return {
        success: true,
        settings: normalizedSettings
    };
}

async function testFirstAccount() {
    const settings = await loadSettings();
    const firstAccount = settings.accounts[0];

    if (!firstAccount?.apiUrl || !firstAccount?.connectionToken) {
        return {
            success: false,
            error: '请先保存至少一个完整账号配置'
        };
    }

    return extractAndSendToken(firstAccount);
}

async function syncAllAccounts() {
    const settings = await loadSettings();
    const accounts = settings.accounts.filter((account) => account.apiUrl && account.connectionToken);

    if (!accounts.length) {
        const error = '没有可同步的账号配置';
        await Logger.error(error);
        return {
            success: false,
            successCount: 0,
            failureCount: 0,
            results: [],
            error
        };
    }

    const results = [];
    for (const account of accounts) {
        results.push(await extractAndSendToken(account));
    }

    const successCount = results.filter((result) => result.success).length;
    const failureCount = results.length - successCount;

    return {
        success: failureCount === 0,
        successCount,
        failureCount,
        results
    };
}

async function notifySummary(summary) {
    if (!summary.results?.length) {
        if (summary.error) {
            await createNotification('❌ Token 同步失败', summary.error);
        }
        return;
    }

    if (summary.results.length === 1) {
        const result = summary.results[0];
        if (result.success) {
            const title = result.action === 'updated' ? '✅ Token 已更新' : '✅ Token 已同步';
            const message = result.displayMessage || result.message || 'Token 已成功同步到 Flow2API';
            await createNotification(title, message);
        } else {
            await createNotification('❌ Token 同步失败', result.error || '未知错误');
        }
        return;
    }

    if (summary.failureCount === 0) {
        const accountNames = summary.results
            .map((result) => result.accountName)
            .slice(0, 3)
            .join('、');

        await createNotification(
            `✅ 已同步 ${summary.successCount} 个账号`,
            accountNames || '所有账号已同步完成'
        );
        return;
    }

    const failedAccounts = summary.results
        .filter((result) => !result.success)
        .map((result) => result.accountName)
        .slice(0, 3)
        .join('、');

    await createNotification(
        `⚠️ ${summary.successCount} 成功 / ${summary.failureCount} 失败`,
        failedAccounts ? `失败账号：${failedAccounts}` : '部分账号同步失败'
    );
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
        await Logger.error('通知发送失败', { error: error.message });
    }
}

async function setupAlarm() {
    await extensionApi.alarms.clear(ALARM_NAME);

    const settings = await loadSettings();
    const hasReadyAccount = settings.accounts.some((account) => account.apiUrl && account.connectionToken);

    if (!hasReadyAccount) {
        await Logger.info('No valid account configured, alarm skipped');
        return;
    }

    extensionApi.alarms.create(ALARM_NAME, {
        periodInMinutes: settings.refreshInterval
    });

    await Logger.info(`Alarm set to ${settings.refreshInterval} minutes`);
}

async function loadSettings() {
    const [syncStored, localStored] = await Promise.all([
        extensionApi.storage.sync.get([
            'accounts',
            'refreshInterval',
            'apiUrl',
            'connectionToken'
        ]),
        extensionApi.storage.local.get([ACCOUNT_SECRETS_KEY])
    ]);
    const localSecrets = normalizeSecretsMap(localStored[ACCOUNT_SECRETS_KEY]);

    let accounts = Array.isArray(syncStored.accounts)
        ? syncStored.accounts.map((account, index) => normalizeAccount({
            ...account,
            connectionToken: resolveAccountSecret(account, localSecrets)
        }, index))
        : [];

    if (!accounts.length && (syncStored.apiUrl || syncStored.connectionToken)) {
        accounts = [
            normalizeAccount({
                name: '默认账号',
                apiUrl: syncStored.apiUrl || '',
                connectionToken: syncStored.connectionToken || '',
                syncSource: 'default',
                cookieStoreId: ''
            }, 0)
        ];
    }

    if (!accounts.length) {
        accounts = [normalizeAccount({ name: '默认账号' }, 0)];
    }

    return {
        accounts,
        refreshInterval: normalizeRefreshInterval(syncStored.refreshInterval)
    };
}

async function migrateLegacyConfig() {
    const [syncStored, localStored] = await Promise.all([
        extensionApi.storage.sync.get(['accounts', 'refreshInterval', 'apiUrl', 'connectionToken']),
        extensionApi.storage.local.get([ACCOUNT_SECRETS_KEY])
    ]);
    const existingSecrets = normalizeSecretsMap(localStored[ACCOUNT_SECRETS_KEY]);

    if (Array.isArray(syncStored.accounts) && syncStored.accounts.length) {
        const normalizedAccounts = syncStored.accounts.map((account, index) => normalizeAccount({
            ...account,
            connectionToken: resolveAccountSecret(account, existingSecrets)
        }, index));
        const needsSanitizedAccounts = syncStored.accounts.some((account) => (
            Object.prototype.hasOwnProperty.call(account, 'connectionToken')
        ));
        const needsSecretMigration = normalizedAccounts.some((account) => (
            account.connectionToken &&
            existingSecrets[account.id] !== account.connectionToken
        ));

        if (!needsSanitizedAccounts && !needsSecretMigration && !syncStored.apiUrl && !syncStored.connectionToken) {
            return false;
        }

        const { syncSettings, localSettings } = splitSettingsForStorage({
            accounts: normalizedAccounts,
            refreshInterval: normalizeRefreshInterval(syncStored.refreshInterval)
        });

        await extensionApi.storage.sync.set(syncSettings);
        await extensionApi.storage.local.set(localSettings);
        await extensionApi.storage.sync.remove(['apiUrl', 'connectionToken']);
        await Logger.info('Settings migrated to split sync/local storage');

        return true;
    }

    if (!syncStored.apiUrl && !syncStored.connectionToken) {
        return false;
    }

    const accounts = [
        normalizeAccount({
            name: '默认账号',
            apiUrl: syncStored.apiUrl || '',
            connectionToken: syncStored.connectionToken || '',
            syncSource: 'default',
            cookieStoreId: ''
        }, 0)
    ];
    const { syncSettings, localSettings } = splitSettingsForStorage({
        accounts,
        refreshInterval: normalizeRefreshInterval(syncStored.refreshInterval)
    });

    await extensionApi.storage.sync.set(syncSettings);
    await extensionApi.storage.local.set(localSettings);
    await extensionApi.storage.sync.remove(['apiUrl', 'connectionToken']);
    await Logger.info('Legacy single-account config migrated');

    return true;
}

function validateAndNormalizeSettings(settings = {}) {
    const refreshInterval = normalizeRefreshInterval(settings.refreshInterval);
    const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];

    if (!accounts.length) {
        throw new Error('至少配置一个账号');
    }

    return {
        accounts: accounts.map((account, index) => validateAccount(account, index)),
        refreshInterval
    };
}

function validateAccount(account, index) {
    const normalized = normalizeAccount(account, index);

    if (!normalized.apiUrl || !normalized.connectionToken) {
        throw new Error(`账号“${normalized.name}”请填写完整的连接接口和连接 Token`);
    }

    try {
        const parsedUrl = new URL(normalized.apiUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('连接接口必须是 http 或 https URL');
        }
    } catch (error) {
        throw new Error(`账号“${normalized.name}”的连接接口不是合法 URL`);
    }

    if (normalized.syncSource === 'store' && !normalized.cookieStoreId) {
        throw new Error(`账号“${normalized.name}”请选择固定的 cookie store`);
    }

    return normalized;
}

function normalizeAccount(account = {}, index = 0) {
    return {
        id: typeof account.id === 'string' && account.id.trim() ? account.id : createId(),
        name: typeof account.name === 'string' && account.name.trim()
            ? account.name.trim()
            : `账号 ${index + 1}`,
        apiUrl: typeof account.apiUrl === 'string' ? account.apiUrl.trim() : '',
        connectionToken: typeof account.connectionToken === 'string' ? account.connectionToken.trim() : '',
        syncSource: ['default', 'activeTab', 'store'].includes(account.syncSource)
            ? account.syncSource
            : 'default',
        cookieStoreId: typeof account.cookieStoreId === 'string' ? account.cookieStoreId.trim() : ''
    };
}

function normalizeRefreshInterval(value) {
    const parsed = Number.parseInt(value, 10);

    if (Number.isNaN(parsed) || parsed < 1 || parsed > 1440) {
        return DEFAULT_REFRESH_INTERVAL;
    }

    return parsed;
}

function splitSettingsForStorage(settings) {
    const accountSecrets = {};
    const publicAccounts = settings.accounts.map((account) => {
        if (account.connectionToken) {
            accountSecrets[account.id] = account.connectionToken;
        }

        return {
            id: account.id,
            name: account.name,
            apiUrl: account.apiUrl,
            syncSource: account.syncSource,
            cookieStoreId: account.cookieStoreId
        };
    });

    return {
        syncSettings: {
            accounts: publicAccounts,
            refreshInterval: settings.refreshInterval
        },
        localSettings: {
            [ACCOUNT_SECRETS_KEY]: accountSecrets
        }
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

function resolveAccountSecret(account, localSecrets) {
    if (account?.id && typeof localSecrets[account.id] === 'string' && localSecrets[account.id].trim()) {
        return localSecrets[account.id].trim();
    }

    if (typeof account?.connectionToken === 'string') {
        return account.connectionToken.trim();
    }

    return '';
}

function createId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `acct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function listCookieStoreOptions() {
    const [activeTab, stores] = await Promise.all([
        getActiveTabSafe(),
        getCookieStoresSafe()
    ]);

    const options = [{
        value: 'default',
        label: '默认会话 / 当前浏览器 profile',
        description: '使用当前浏览器 profile 的默认登录态'
    }];

    if (activeTab?.cookieStoreId) {
        options.push({
            value: 'activeTab',
            label: '跟随当前活动标签',
            description: `当前活动会话：${describeCookieStoreId(activeTab.cookieStoreId)}`
        });
    }

    const seen = new Set(options.map((option) => option.value));

    for (const store of stores) {
        if (!store?.id || seen.has(store.id)) {
            continue;
        }

        options.push(await buildCookieStoreOption(store, activeTab));
        seen.add(store.id);
    }

    return options;
}

async function buildCookieStoreOption(store, activeTab) {
    const details = [];
    const firstTab = await getFirstTabForStore(store);

    if (store.id === activeTab?.cookieStoreId) {
        details.push('当前活动');
    }

    if (store.incognito) {
        details.push('隐私窗口');
    }

    if (Array.isArray(store.tabIds) && store.tabIds.length) {
        details.push(`${store.tabIds.length} 个标签`);
    }

    if (firstTab?.title) {
        details.push(trimText(firstTab.title, 18));
    }

    return {
        value: store.id,
        label: describeCookieStoreId(store.id),
        description: details.join(' · ') || '可手动绑定到该会话'
    };
}

function describeCookieStoreId(storeId) {
    if (!storeId) {
        return '默认会话';
    }

    if (storeId === 'firefox-default') {
        return '默认会话 / 无容器';
    }

    if (storeId.startsWith('firefox-container-')) {
        return `Firefox / Zen 容器 ${storeId.replace('firefox-container-', '')}`;
    }

    if (storeId === '0') {
        return '主浏览器会话';
    }

    if (storeId === '1') {
        return '隐私窗口会话';
    }

    return `Cookie Store ${storeId}`;
}

async function getActiveTabSafe() {
    try {
        const tabs = await extensionApi.tabs.query({
            active: true,
            lastFocusedWindow: true
        });

        if (tabs.length) {
            return tabs[0];
        }
    } catch (error) {
        await Logger.info('Failed to query active tab with lastFocusedWindow', {
            error: error.message
        });
    }

    try {
        const tabs = await extensionApi.tabs.query({
            active: true,
            currentWindow: true
        });

        return tabs[0] || null;
    } catch (error) {
        await Logger.info('Failed to query active tab with currentWindow', {
            error: error.message
        });
        return null;
    }
}

async function getCookieStoresSafe() {
    try {
        return await extensionApi.cookies.getAllCookieStores();
    } catch (error) {
        await Logger.info('Failed to enumerate cookie stores', {
            error: error.message
        });
        return [];
    }
}

async function getFirstTabForStore(store) {
    if (!Array.isArray(store.tabIds) || !store.tabIds.length) {
        return null;
    }

    try {
        return await extensionApi.tabs.get(store.tabIds[0]);
    } catch (error) {
        return null;
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

async function resolveCookieContext(account) {
    const activeTab = await getActiveTabSafe();

    if (account.syncSource === 'activeTab') {
        return {
            cookieStoreId: activeTab?.cookieStoreId || null,
            windowId: activeTab?.windowId,
            sourceLabel: activeTab?.cookieStoreId
                ? `跟随当前活动标签：${describeCookieStoreId(activeTab.cookieStoreId)}`
                : '跟随当前活动标签：默认会话'
        };
    }

    if (account.syncSource === 'store' && account.cookieStoreId) {
        const matchingTab = await findTabByCookieStoreId(account.cookieStoreId);

        return {
            cookieStoreId: account.cookieStoreId,
            windowId: matchingTab?.windowId || activeTab?.windowId,
            sourceLabel: `固定 cookie store：${describeCookieStoreId(account.cookieStoreId)}`
        };
    }

    return {
        cookieStoreId: null,
        windowId: activeTab?.windowId,
        sourceLabel: '默认会话 / 当前浏览器 profile'
    };
}

async function findTabByCookieStoreId(cookieStoreId) {
    try {
        const tabs = await extensionApi.tabs.query({});
        return tabs.find((tab) => tab.cookieStoreId === cookieStoreId) || null;
    } catch (error) {
        return null;
    }
}

async function extractAndSendToken(rawAccount) {
    const account = validateAccount(rawAccount, 0);
    const accountName = account.name;

    let tabId = null;

    try {
        await Logger.info('Starting token extraction', {
            accountName,
            syncSource: account.syncSource
        });

        const cookieContext = await resolveCookieContext(account);
        await Logger.info('Cookie context resolved', {
            accountName,
            cookieStoreId: cookieContext.cookieStoreId,
            sourceLabel: cookieContext.sourceLabel
        });

        const tab = await openLabsTab(cookieContext, account.syncSource !== 'store');
        tabId = tab.id;

        await Logger.info('Google Labs tab created', {
            accountName,
            tabId
        });

        await waitForTabLoad(tabId);
        await sleep(SESSION_WAIT_MS);

        const cookieResult = await findSessionToken(cookieContext.cookieStoreId);
        await closeTabIfNeeded(tabId);
        tabId = null;

        if (!cookieResult.token) {
            await Logger.error('Session token not found', {
                accountName,
                sourceLabel: cookieContext.sourceLabel,
                inspectedCookies: cookieResult.inspectedCookies
            });

            return {
                success: false,
                accountName,
                sourceLabel: cookieContext.sourceLabel,
                error: '未找到 session-token。请确认该账号已在对应 profile / 容器中登录 Google Labs。'
            };
        }

        await Logger.success('Session token extracted', {
            accountName,
            sourceLabel: cookieContext.sourceLabel,
            domain: cookieResult.cookie?.domain,
            storeId: cookieResult.cookie?.storeId || cookieContext.cookieStoreId || null,
            tokenLength: cookieResult.token.length
        });

        const response = await fetch(account.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${account.connectionToken}`
            },
            body: JSON.stringify({
                session_token: cookieResult.token
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            await Logger.error('Upstream server returned an error', {
                accountName,
                status: response.status,
                error: errorText
            });

            return {
                success: false,
                accountName,
                sourceLabel: cookieContext.sourceLabel,
                error: `服务器错误: ${response.status}`
            };
        }

        const result = await response.json();
        const displayMessage = result.action === 'updated'
            ? `✅ 成功更新到上游\n${result.message || 'Token 更新成功'}`
            : `✅ 成功添加到上游\n${result.message || 'Token 添加成功'}`;

        await Logger.success('Token synced to upstream', {
            accountName,
            action: result.action || 'unknown',
            message: result.message,
            sourceLabel: cookieContext.sourceLabel
        });

        return {
            success: true,
            accountName,
            sourceLabel: cookieContext.sourceLabel,
            message: result.message || 'Token 更新成功',
            action: result.action,
            displayMessage
        };
    } catch (error) {
        await Logger.error('Token sync failed', {
            accountName,
            error: error.message,
            stack: error.stack
        });

        await closeTabIfNeeded(tabId);

        return {
            success: false,
            accountName,
            error: error.message
        };
    }
}

async function openLabsTab(cookieContext, allowFallback = false) {
    const createProperties = {
        url: LABS_URL,
        active: false
    };

    if (typeof cookieContext.windowId === 'number') {
        createProperties.windowId = cookieContext.windowId;
    }

    if (cookieContext.cookieStoreId) {
        createProperties.cookieStoreId = cookieContext.cookieStoreId;
    }

    try {
        return await extensionApi.tabs.create(createProperties);
    } catch (error) {
        if (!cookieContext.cookieStoreId || !allowFallback) {
            throw error;
        }

        await Logger.info('tabs.create with cookieStoreId failed, retrying without cookieStoreId', {
            error: error.message,
            cookieStoreId: cookieContext.cookieStoreId
        });

        delete createProperties.cookieStoreId;
        return extensionApi.tabs.create(createProperties);
    }
}

async function findSessionToken(cookieStoreId) {
    const cookie = await getSessionCookie(cookieStoreId);
    if (cookie?.value) {
        return {
            token: cookie.value,
            cookie,
            inspectedCookies: []
        };
    }

    const queries = [
        { url: LABS_URL },
        { domain: 'labs.google' }
    ];

    const allCookies = [];
    for (const baseQuery of queries) {
        const query = { ...baseQuery };
        if (cookieStoreId) {
            query.storeId = cookieStoreId;
        }

        try {
            const cookies = await extensionApi.cookies.getAll(query);
            allCookies.push(...cookies);
        } catch (error) {
            await Logger.info('Cookie query failed', {
                query,
                error: error.message
            });
        }
    }

    const uniqueCookies = Array.from(
        new Map(allCookies.map((item) => [
            `${item.storeId || ''}:${item.name}:${item.domain}:${item.path}`,
            item
        ])).values()
    );

    const matchedCookie = uniqueCookies.find((item) => item.name === SESSION_COOKIE_NAME) || null;

    return {
        token: matchedCookie?.value || null,
        cookie: matchedCookie,
        inspectedCookies: uniqueCookies.map((item) => ({
            name: item.name,
            domain: item.domain,
            storeId: item.storeId || null
        }))
    };
}

async function getSessionCookie(cookieStoreId) {
    const attempts = [
        {
            url: LABS_URL,
            name: SESSION_COOKIE_NAME
        },
        {
            url: 'https://labs.google/',
            name: SESSION_COOKIE_NAME
        }
    ];

    for (const baseAttempt of attempts) {
        const attempt = { ...baseAttempt };
        if (cookieStoreId) {
            attempt.storeId = cookieStoreId;
        }

        try {
            const cookie = await extensionApi.cookies.get(attempt);
            if (cookie?.value) {
                return cookie;
            }
        } catch (error) {
            await Logger.info('Cookie lookup failed', {
                attempt,
                error: error.message
            });
        }
    }

    return null;
}

async function waitForTabLoad(tabId, timeoutMs = 20000) {
    try {
        const existingTab = await extensionApi.tabs.get(tabId);
        if (existingTab?.status === 'complete') {
            return;
        }
    } catch (error) {
        // Fall through to the listener path below.
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
        // Ignore tab closing failures.
    }
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function trimText(value, maxLength) {
    if (!value || value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength - 1)}…`;
}
