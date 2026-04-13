const extensionApi = globalThis.browser ?? globalThis.chrome;

const state = {
    baseUrl: '',
    suggestedBaseUrl: '',
    lastSync: null,
    browserInfo: null,
    hasConnection: false,
    configSource: 'none'
};

let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadSetupData();
});

function bindEvents() {
    document.getElementById('connectBtn').addEventListener('click', runPrimaryAction);
    document.getElementById('consoleBtn').addEventListener('click', openConsole);
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
        state.hasConnection = Boolean(response.hasConnection || response.settings?.connectionToken);
        state.configSource = response.settings?.configSource || 'none';

        render(true);

        if (state.lastSync?.status === 'success') {
            showStatus('这个 Profile 已经就绪。', 'success');
        } else if (state.lastSync?.status === 'error') {
            showStatus(state.lastSync.message || '这次同步没有完成。', 'error');
        } else if (state.hasConnection && state.configSource === 'sync') {
            showStatus('已沿用同浏览器里的 Flow2API 设置。现在只需要同步这个 Profile。', 'info');
        } else if (state.lastSync?.status === 'waiting_session' || state.hasConnection) {
            showStatus(state.lastSync?.message || 'Flow2API 已接入，等你在这个 Profile 登录 Labs。', 'info');
        } else if (state.baseUrl) {
            showStatus('确认这个地址后，就可以把当前 Profile 接到 Flow2API。', 'info');
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

    renderSummary();
    renderExperience();
}

function renderSummary() {
    const browserName = state.browserInfo?.name
        ? `${state.browserInfo.name} ${state.browserInfo.version || ''}`.trim()
        : '当前浏览器';

    document.getElementById('browserHint').textContent =
        `${browserName} 里的每个 Profile 都有自己的 Google 登录态。扩展只处理当前这个 Profile，Flow2API 地址会尽量自动沿用。`;

    const hasBaseUrl = Boolean(state.baseUrl);
    const hasConnection = Boolean(state.hasConnection);
    const lastSync = state.lastSync;

    let stateLabel = '未接入';
    let stateClass = 'waiting';

    if (hasConnection && lastSync?.status === 'error') {
        stateLabel = '需要处理';
        stateClass = 'warning';
    } else if (hasConnection) {
        stateLabel = '已接入';
        stateClass = 'connected';
    } else if (hasBaseUrl && lastSync?.status === 'error') {
        stateLabel = '需要处理';
        stateClass = 'warning';
    } else if (hasBaseUrl) {
        stateLabel = '准备接入';
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
    document.getElementById('summaryMessage').textContent = lastSync?.message
        || (hasConnection
            ? 'Flow2API 已接入。这个 Profile 的 Google Labs 登录态有变化时，扩展会自动同步。'
            : '第一次只要确认一次 Flow2API 地址，后续同步会自动完成。');

}

function renderExperience() {
    const ui = getUiModel();

    document.getElementById('heroTitle').textContent = ui.title;
    document.getElementById('heroText').textContent = ui.text;
    document.getElementById('connectBtn').textContent = ui.actionLabel;
    document.getElementById('actionNote').textContent = ui.actionNote;
}

function getUiModel() {
    const hasBaseUrl = Boolean(state.baseUrl || state.suggestedBaseUrl);
    const hasConnection = Boolean(state.hasConnection);
    const lastSync = state.lastSync;

    if (!hasConnection) {
        return {
            title: hasBaseUrl ? '确认后立刻接入' : '先接入 Flow2API',
            text: hasBaseUrl
                ? '扩展会读取已登录控制台里的设置，然后开始接管这个 Profile 的同步。'
                : '先告诉扩展你的 Flow2API 控制台在哪，后续同步就不需要你反复操作。',
            actionLabel: '接入 Flow2API',
            actionNote: '第一次只做一件事：把这个 Profile 接到你的 Flow2API。'
        };
    }

    if (lastSync?.status === 'error') {
        return {
            title: '这次同步没有完成',
            text: 'Flow2API 已经接入好了。现在只需要重新检查这个 Profile 的 Google Labs 登录态。',
            actionLabel: '再试一次',
            actionNote: '点一下就会重新检查当前这个 Profile，而不会改动别的 Profile。'
        };
    }

    if (lastSync?.status === 'success') {
        return {
            title: '这个 Profile 已经就绪',
            text: 'Google Labs 登录态有变化时，扩展会自动同步到 Flow2API。你通常不需要手动操作。',
            actionLabel: '立即重新同步',
            actionNote: '只有在你刚切换 Labs 账号，或者想立刻刷新时，才需要点这一下。'
        };
    }

    if (state.configSource === 'sync') {
        return {
            title: '这个 Profile 还没开始同步',
            text: '我已经沿用了同浏览器里的 Flow2API 设置。现在只需要读取这个 Profile 自己的 Labs 登录态。',
            actionLabel: '同步这个 Profile',
            actionNote: '不会影响其他 Profile，只会处理你现在打开的这个。'
        };
    }

    return {
        title: '等你在这个 Profile 登录 Labs',
        text: 'Flow2API 已经接入。你在这个 Profile 登录 Google Labs 后，扩展会自动完成同步。',
        actionLabel: '同步这个 Profile',
        actionNote: '如果你刚刚登录完成，点一下就会立刻检查，不用等后台自己发现。'
    };
}

async function runPrimaryAction() {
    if (state.hasConnection) {
        return syncCurrentProfile();
    }

    return connectFlow2Api();
}

async function connectFlow2Api() {
    try {
        const baseUrl = collectBaseUrl();
        const originPattern = toOriginPattern(baseUrl);

        setBusy(true);
        showStatus('正在连接 Flow2API...', 'info');

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
        state.hasConnection = true;
        state.configSource = 'local';
        render();

        const statusType = response.lastSync?.status === 'error'
            ? 'error'
            : (response.synced === false ? 'info' : 'success');

        showStatus(
            response.message || 'Flow2API 已接入。',
            statusType
        );
    } catch (error) {
        showStatus(error.message, 'error');
    } finally {
        setBusy(false);
    }
}

async function syncCurrentProfile() {
    try {
        const baseUrl = collectBaseUrl();
        const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
        const originPattern = toOriginPattern(normalizedBaseUrl);

        setBusy(true);
        showStatus('正在检查当前 Profile 的 Google Labs 登录态...', 'info');

        await ensureHostPermission(originPattern);

        let response;

        if (!state.baseUrl || state.baseUrl !== normalizedBaseUrl || !state.hasConnection) {
            response = await extensionApi.runtime.sendMessage({
                action: 'connectBaseUrl',
                baseUrl: normalizedBaseUrl
            });
        } else {
            response = await extensionApi.runtime.sendMessage({
                action: 'syncNow'
            });
        }

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

        state.baseUrl = normalizedBaseUrl;
        state.lastSync = response.lastSync || state.lastSync;
        state.hasConnection = Boolean(response.hasConnection || state.hasConnection);
        render();

        const statusType = response.lastSync?.status === 'error'
            ? 'error'
            : (response.synced === false ? 'info' : 'success');

        showStatus(
            response.message || '这个 Profile 已同步。',
            statusType
        );
    } catch (error) {
        showStatus(error.message, 'error');
    } finally {
        setBusy(false);
    }
}

async function openConsole() {
    try {
        const baseUrl = collectBaseUrl(true);
        if (!baseUrl) {
            throw new Error('请先填写 Flow2API 地址');
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
    if (!extensionApi.permissions?.request) {
        return;
    }

    // permissions.request must be triggered directly from a user gesture.
    // Avoid any preceding async permission checks here.
    const approved = await extensionApi.permissions.request({
        origins: [originPattern]
    });

    if (!approved) {
        throw new Error('需要允许扩展访问这个 Flow2API 地址，才能自动读取控制台设置');
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

        throw new Error('请填写 Flow2API 地址');
    }

    return normalizeBaseUrl(raw);
}

function normalizeBaseUrl(raw) {
    let value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
        throw new Error('请填写 Flow2API 地址');
    }

    if (!/^[a-z]+:\/\//i.test(value)) {
        value = `https://${value}`;
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw new Error('Flow2API 地址不是合法网址');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Flow2API 地址必须以 http:// 或 https:// 开头');
    }

    return parsed.origin;
}

function toOriginPattern(baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/*`;
}

function setBusy(isBusy) {
    document.getElementById('connectBtn').disabled = isBusy;
    document.getElementById('consoleBtn').disabled = isBusy || !hasConsoleTarget();
    document.body.classList.toggle('busy', isBusy);
}

function hasConsoleTarget() {
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
