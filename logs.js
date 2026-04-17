const extensionApi = globalThis.browser ?? globalThis.chrome;
const DEFAULT_STORE_KEY = '__default__';
const state = {
    activeCookieStoreId: null,
    activeStoreKey: DEFAULT_STORE_KEY,
    showAllStores: false
};

async function getCurrentCookieStoreId() {
    if (!extensionApi.tabs?.query) {
        return null;
    }

    try {
        const tabs = await extensionApi.tabs.query({
            active: true,
            currentWindow: true
        });

        return tabs[0]?.cookieStoreId || null;
    } catch (error) {
        return null;
    }
}

function storeKeyFromCookieStoreId(cookieStoreId) {
    return cookieStoreId || DEFAULT_STORE_KEY;
}

function describeStore(cookieStoreId) {
    return cookieStoreId || '默认 Profile / store';
}

async function ensureActiveStoreContext() {
    if (state.activeCookieStoreId !== null || state.activeStoreKey !== DEFAULT_STORE_KEY) {
        return;
    }

    state.activeCookieStoreId = await getCurrentCookieStoreId();
    state.activeStoreKey = storeKeyFromCookieStoreId(state.activeCookieStoreId);
}

async function fetchLogs() {
    await ensureActiveStoreContext();
    const response = await extensionApi.runtime.sendMessage({
        action: 'getLogs',
        filterByStore: !state.showAllStores,
        storeKey: state.activeStoreKey,
        includeGlobal: true
    });

    if (!response?.success) {
        throw new Error(response?.error || '加载日志失败');
    }

    return response.logs || [];
}

async function fetchSetupData() {
    await ensureActiveStoreContext();
    const response = await extensionApi.runtime.sendMessage({
        action: 'getSetupData',
        cookieStoreId: state.activeCookieStoreId,
        previewCurrentSession: true
    });

    if (!response?.success) {
        throw new Error(response?.error || '加载当前状态失败');
    }

    return {
        cookieStoreId: state.activeCookieStoreId,
        browserInfo: response.browserInfo || null,
        hasConnection: Boolean(response.hasConnection),
        settings: response.settings || null
    };
}

// 格式化时间
function formatTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;

    // 如果是今天
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // 如果是昨天
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    // 其他日期
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function createEmptyState(icon, text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';

    const iconEl = document.createElement('div');
    iconEl.className = 'empty-state-icon';
    iconEl.textContent = icon;

    const textEl = document.createElement('div');
    textEl.textContent = text;

    wrapper.appendChild(iconEl);
    wrapper.appendChild(textEl);

    return wrapper;
}

function updateScopeUi() {
    const scopeBtn = document.getElementById('scopeBtn');
    const filterNote = document.getElementById('filterNote');
    const currentScopeLabel = describeStore(state.activeCookieStoreId);

    scopeBtn.textContent = state.showAllStores ? '只看当前' : '查看全部';
    filterNote.textContent = state.showAllStores
        ? `当前显示全部 Profile / store 的日志；当前页面属于 ${currentScopeLabel}`
        : `当前只显示 ${currentScopeLabel} 的日志，并附带少量全局事件`;
}

// 渲染日志
function renderLogs(logs) {
    const container = document.getElementById('logsContainer');
    container.replaceChildren();

    if (!logs || logs.length === 0) {
        container.appendChild(createEmptyState('📝', '暂无日志记录'));
        return;
    }

    logs.forEach((log) => {
        const entry = document.createElement('div');
        entry.className = `log-entry ${log.level}`;

        const header = document.createElement('div');
        header.className = 'log-header';

        const level = document.createElement('span');
        level.className = `log-level ${log.level}`;
        level.textContent = log.level;

        const time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = formatTime(log.timestamp);

        header.appendChild(level);
        header.appendChild(time);

        const message = document.createElement('div');
        message.className = 'log-message';
        message.textContent = log.message;

        entry.appendChild(header);
        entry.appendChild(message);

        if (log.details) {
            const details = document.createElement('div');
            details.className = 'log-details';
            details.textContent = JSON.stringify(log.details, null, 2);
            entry.appendChild(details);
        }

        container.appendChild(entry);
    });
}

// 加载日志
async function loadLogs() {
    try {
        await ensureActiveStoreContext();
        updateScopeUi();
        renderLogs(await fetchLogs());
    } catch (error) {
        const container = document.getElementById('logsContainer');
        container.replaceChildren(createEmptyState('❌', error.message || '加载日志失败'));
    }
}

// 清空日志
async function clearLogs() {
    if (!confirm('确定要清空所有日志吗？')) {
        return;
    }

    const response = await extensionApi.runtime.sendMessage({ action: 'clearLogs' });
    if (response && response.success) {
        loadLogs();
    }
}

async function copyDiagnostics() {
    const copyButton = document.getElementById('copyBtn');
    const originalLabel = copyButton.textContent;
    copyButton.disabled = true;

    try {
        const [setup, logs] = await Promise.all([
            fetchSetupData(),
            fetchLogs()
        ]);

        const payload = {
            exportedAt: new Date().toISOString(),
            activeCookieStoreId: setup.cookieStoreId,
            activeStoreKey: state.activeStoreKey,
            scope: state.showAllStores ? 'all' : 'current_store',
            browserInfo: setup.browserInfo,
            hasConnection: setup.hasConnection,
            settings: sanitizeSetupForExport(setup.settings),
            logs
        };

        const text = JSON.stringify(payload, null, 2);
        await writeTextToClipboard(text);
        copyButton.textContent = '已复制';
    } catch (error) {
        copyButton.textContent = '复制失败';
    } finally {
        setTimeout(() => {
            copyButton.disabled = false;
            copyButton.textContent = originalLabel;
        }, 1500);
    }
}

function sanitizeSetupForExport(settings) {
    if (!settings || typeof settings !== 'object') {
        return settings;
    }

    const sanitized = { ...settings };
    if (Object.prototype.hasOwnProperty.call(settings, 'connectionToken')) {
        sanitized.connectionToken = maskSecret(settings.connectionToken);
    }

    return sanitized;
}

function maskSecret(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return value || '';
    }

    const trimmed = value.trim();
    if (trimmed.length <= 8) {
        return '*'.repeat(trimmed.length);
    }

    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function toggleScope() {
    state.showAllStores = !state.showAllStores;
    loadLogs();
}

async function writeTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadLogs();

    // 刷新按钮
    document.getElementById('refreshBtn').addEventListener('click', loadLogs);

    // 当前 store / 全部切换
    document.getElementById('scopeBtn').addEventListener('click', toggleScope);

    // 清空按钮
    document.getElementById('clearBtn').addEventListener('click', clearLogs);

    // 复制诊断
    document.getElementById('copyBtn').addEventListener('click', copyDiagnostics);

    // 返回按钮
    document.getElementById('backBtn').addEventListener('click', () => {
        window.location.href = 'popup.html';
    });

    // 自动刷新（每5秒）
    setInterval(loadLogs, 5000);
});
