const extensionApi = globalThis.browser ?? globalThis.chrome;

const state = {
    baseUrl: '',
    suggestedBaseUrl: '',
    lastSync: null,
    browserInfo: null
};

let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadSetupData();
});

function bindEvents() {
    document.getElementById('connectBtn').addEventListener('click', connectAndSync);
    document.getElementById('syncBtn').addEventListener('click', syncNow);
    document.getElementById('consoleBtn').addEventListener('click', openConsole);
    document.getElementById('logsBtn').addEventListener('click', () => {
        window.location.href = 'logs.html';
    });
}

async function loadSetupData() {
    try {
        setBusy(true);
        showStatus('正在读取当前配置...', 'info');

        const response = await extensionApi.runtime.sendMessage({
            action: 'getSetupData'
        });

        if (!response?.success) {
            throw new Error(response?.error || '加载失败');
        }

        state.baseUrl = response.settings?.baseUrl || '';
        state.lastSync = response.settings?.lastSync || null;
        state.browserInfo = response.browserInfo || null;
        state.suggestedBaseUrl = response.suggestedBaseUrl || '';

        render(true);

        if (state.lastSync?.status === 'success') {
            showStatus('已读取当前配置', 'success');
        } else if (state.baseUrl) {
            showStatus('已准备好连接 Flow2API', 'info');
        } else {
            hideStatusSoon();
        }
    } catch (error) {
        showStatus(`加载失败：${error.message}`, 'error');
    } finally {
        setBusy(false);
    }
}

function render(allowPrefill = false) {
    const input = document.getElementById('baseUrl');
    const nextValue = state.baseUrl || state.suggestedBaseUrl || '';

    if (allowPrefill || !input.value.trim()) {
        input.value = nextValue;
    }

    document.getElementById('syncBtn').disabled = !(state.baseUrl && state.lastSync);
    renderSummary();
}

function renderSummary() {
    const browserName = state.browserInfo?.name
        ? `${state.browserInfo.name} ${state.browserInfo.version || ''}`.trim()
        : '当前浏览器';

    document.getElementById('browserHint').textContent =
        `${browserName} 会监听 Google Labs 登录态变化，并自动把当前 profile 的 session 同步到 Flow2API。`;

    const hasBaseUrl = Boolean(state.baseUrl);
    const lastSync = state.lastSync;

    let stateLabel = '等待连接';
    let stateClass = 'waiting';

    if (hasBaseUrl && lastSync?.status === 'success') {
        stateLabel = '已连接';
        stateClass = 'connected';
    } else if (hasBaseUrl && lastSync?.status === 'error') {
        stateLabel = '需要处理';
        stateClass = 'warning';
    } else if (hasBaseUrl) {
        stateLabel = '等待首次同步';
        stateClass = 'waiting';
    }

    const connectionChip = document.getElementById('connectionChip');
    connectionChip.textContent = stateLabel;
    connectionChip.className = `chip ${stateClass}`;

    document.getElementById('summaryBaseUrl').textContent = hasBaseUrl
        ? state.baseUrl
        : (state.suggestedBaseUrl || '未设置');

    document.getElementById('summaryEmail').textContent = lastSync?.email || '等待识别';
    document.getElementById('summaryExpires').textContent = formatDateTime(
        lastSync?.atExpires || lastSync?.sessionExpiresAt
    );
    document.getElementById('summaryLastSync').textContent = formatDateTime(lastSync?.syncedAt);
    document.getElementById('summaryMessage').textContent = lastSync?.message || '填入 Base URL 后，扩展会自动读取控制台配置并同步。';

    document.getElementById('syncBtn').disabled = !hasBaseUrl;
}

async function connectAndSync() {
    try {
        const baseUrl = collectBaseUrl();
        const originPattern = toOriginPattern(baseUrl);

        setBusy(true);
        showStatus('正在连接 Flow2API 控制台...', 'info');

        await ensureHostPermission(originPattern);

        const response = await extensionApi.runtime.sendMessage({
            action: 'connectBaseUrl',
            baseUrl
        });

        if (!response?.success) {
            state.baseUrl = normalizeBaseUrl(baseUrl);

            if (response?.lastSync) {
                state.lastSync = response.lastSync;
            }

            render();

            if (response?.needsLogin) {
                showStatus(response.message || '请先登录 Flow2API 控制台', 'info');
                return;
            }

            throw new Error(response?.error || '连接失败');
        }

        state.baseUrl = normalizeBaseUrl(baseUrl);
        state.lastSync = response.lastSync || state.lastSync;
        render();

        showStatus(response.message || '已连接并同步成功', 'success');
    } catch (error) {
        showStatus(error.message, 'error');
    } finally {
        setBusy(false);
    }
}

async function syncNow() {
    try {
        const baseUrl = collectBaseUrl();
        const originPattern = toOriginPattern(baseUrl);

        setBusy(true);
        showStatus('正在同步当前浏览器的 Google Labs 登录态...', 'info');

        await ensureHostPermission(originPattern);

        if (!state.baseUrl || state.baseUrl !== normalizeBaseUrl(baseUrl)) {
            const connectResponse = await extensionApi.runtime.sendMessage({
                action: 'connectBaseUrl',
                baseUrl
            });

            if (!connectResponse?.success) {
                state.baseUrl = normalizeBaseUrl(baseUrl);

                if (connectResponse?.lastSync) {
                    state.lastSync = connectResponse.lastSync;
                }

                render();

                if (connectResponse?.needsLogin) {
                    showStatus(connectResponse.message || '请先登录 Flow2API 控制台', 'info');
                    return;
                }

                throw new Error(connectResponse?.error || '连接失败');
            }

            state.baseUrl = normalizeBaseUrl(baseUrl);
            state.lastSync = connectResponse.lastSync || state.lastSync;
            render();
            showStatus(connectResponse.message || '同步成功', 'success');
            return;
        }

        const response = await extensionApi.runtime.sendMessage({
            action: 'syncNow'
        });

        if (!response?.success) {
            if (response?.lastSync) {
                state.lastSync = response.lastSync;
                render();
            }

            if (response?.needsLogin) {
                showStatus(response.message || '请先登录 Flow2API 控制台', 'info');
                return;
            }

            throw new Error(response?.error || '同步失败');
        }

        state.lastSync = response.lastSync || state.lastSync;
        render();
        showStatus(response.message || '同步成功', 'success');
    } catch (error) {
        showStatus(`同步失败：${error.message}`, 'error');
    } finally {
        setBusy(false);
    }
}

async function openConsole() {
    try {
        const baseUrl = collectBaseUrl(true);
        if (!baseUrl) {
            throw new Error('请先填写 Flow2API Base URL');
        }

        await extensionApi.runtime.sendMessage({
            action: 'openConsole',
            baseUrl
        });

        showStatus('已打开 Flow2API 控制台', 'info');
    } catch (error) {
        showStatus(error.message, 'error');
    }
}

async function ensureHostPermission(originPattern) {
    if (!extensionApi.permissions?.contains || !extensionApi.permissions?.request) {
        return;
    }

    const granted = await extensionApi.permissions.contains({
        origins: [originPattern]
    });

    if (granted) {
        return;
    }

    const approved = await extensionApi.permissions.request({
        origins: [originPattern]
    });

    if (!approved) {
        throw new Error('需要授权访问这个 Flow2API 域名，扩展才能自动读取控制台配置');
    }
}

function collectBaseUrl(allowEmpty = false) {
    const raw = document.getElementById('baseUrl').value.trim()
        || state.baseUrl
        || state.suggestedBaseUrl;

    if (!raw) {
        if (allowEmpty) {
            return '';
        }

        throw new Error('请填写 Flow2API Base URL');
    }

    return normalizeBaseUrl(raw);
}

function normalizeBaseUrl(raw) {
    let value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
        throw new Error('请填写 Flow2API Base URL');
    }

    if (!/^[a-z]+:\/\//i.test(value)) {
        value = `https://${value}`;
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw new Error('Base URL 不是合法地址');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Base URL 必须以 http:// 或 https:// 开头');
    }

    return parsed.origin;
}

function toOriginPattern(baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/*`;
}

function setBusy(isBusy) {
    document.getElementById('connectBtn').disabled = isBusy;
    document.getElementById('syncBtn').disabled = isBusy || !collectSyncEligibility();
    document.getElementById('consoleBtn').disabled = isBusy;
    document.body.classList.toggle('busy', isBusy);
}

function collectSyncEligibility() {
    return Boolean(
        document.getElementById('baseUrl').value.trim()
        || state.baseUrl
        || state.suggestedBaseUrl
    );
}

function showStatus(message, type) {
    const el = document.getElementById('status');
    el.textContent = message;
    el.className = `status ${type}`;
    el.style.display = 'block';
    hideStatusSoon();
}

function hideStatusSoon() {
    if (statusTimer) {
        clearTimeout(statusTimer);
    }

    statusTimer = setTimeout(() => {
        document.getElementById('status').style.display = 'none';
    }, 5000);
}

function formatDateTime(value) {
    if (!value) {
        return '未获取';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '未获取';
    }

    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).replace(/\//g, '-');
}
