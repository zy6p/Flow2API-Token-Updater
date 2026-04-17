const extensionApi = globalThis.browser ?? globalThis.chrome;

const state = {
    baseUrl: '',
    suggestedBaseUrl: '',
    lastSync: null,
    browserInfo: null,
    hasConnection: false,
    configSource: 'none',
    periodicSyncMinutes: 240,
    nextScheduledAt: null,
    nextScheduledReason: null
};

let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadSetupData();
});

function bindEvents() {
    document.getElementById('connectBtn').addEventListener('click', runPrimaryAction);
    document.getElementById('periodicSyncMinutes').addEventListener('change', updateSyncPreferences);
    document.getElementById('refreshStatusBtn').addEventListener('click', refreshStatus);
    document.getElementById('consoleBtn').addEventListener('click', openConsole);
    document.getElementById('logsBtn').addEventListener('click', openLogs);
}

async function loadSetupData() {
    try {
        setBusy(true);
        showStatus('正在读取当前配置...', 'info');
        const cookieStoreId = await getCurrentCookieStoreId();

        const response = await extensionApi.runtime.sendMessage({
            action: 'getSetupData',
            cookieStoreId,
            previewCurrentSession: true
        });

        if (!response?.success) {
            throw new Error(response?.error || '加载失败');
        }

        applySetupResponse(response);
        render(true);
        showStatusForCurrentState();
    } catch (error) {
        showStatus(`加载失败：${error.message}`, 'error');
    } finally {
        setBusy(false);
    }
}

function applySetupResponse(response) {
    state.baseUrl = response.settings?.baseUrl || '';
    state.lastSync = response.settings?.lastSync || null;
    state.browserInfo = response.browserInfo || null;
    state.suggestedBaseUrl = response.suggestedBaseUrl || '';
    state.hasConnection = Boolean(response.hasConnection);
    state.configSource = response.settings?.configSource || 'none';
    state.periodicSyncMinutes = normalizePeriodicSyncMinutes(response.settings?.periodicSyncMinutes);
    state.nextScheduledAt = response.settings?.nextScheduledAt || null;
    state.nextScheduledReason = response.settings?.nextScheduledReason || null;
}

function showStatusForCurrentState() {
    if (state.lastSync?.status === 'success') {
        showStatus('这个 Profile 已经就绪。', 'success');
    } else if (state.lastSync?.status === 'detected_session') {
        showStatus(state.lastSync.message || '检测到当前账号，点一下就可以同步这个账号。', 'info');
    } else if (state.lastSync?.status === 'error') {
        showStatus(state.lastSync.message || '这次同步没有完成。', 'error');
    } else if (state.lastSync?.status === 'waiting_session' || state.hasConnection) {
        showStatus(state.lastSync?.message || 'Flow2API 已接入，等你在这个 Profile 登录 Labs。', 'info');
    } else if (state.baseUrl) {
        showStatus('确认这个地址后，就可以把当前 Profile 接到 Flow2API。', 'info');
    } else {
        hideStatusSoon();
    }
}

function render(allowPrefill = false) {
    const input = document.getElementById('baseUrl');
    const nextValue = state.baseUrl || state.suggestedBaseUrl || '';

    if (allowPrefill || !input.value.trim()) {
        input.value = nextValue;
    }

    renderPreferences();
    renderSummary();
    renderExperience();
}

function renderPreferences() {
    const select = document.getElementById('periodicSyncMinutes');
    const normalizedValue = String(normalizePeriodicSyncMinutes(state.periodicSyncMinutes));

    if (select.value !== normalizedValue) {
        select.value = normalizedValue;
    }

    document.getElementById('intervalHint').textContent =
        `没检测到明显变化时，扩展仍会最多每 ${formatMinutesLabel(state.periodicSyncMinutes)} 自动重刷一次。`;
}

function renderSummary() {
    const browserName = state.browserInfo?.name
        ? `${state.browserInfo.name} ${state.browserInfo.version || ''}`.trim()
        : '当前浏览器';

    document.getElementById('browserHint').textContent =
        `${browserName} 里的真实 Profile 彼此隔离；在 Firefox / Zen 里，不同容器 / cookie store 会分别维护自己的 Labs 会话和最近同步状态，但同一个浏览器里的 Flow2API 连接配置可以复用。扩展只会同步当前这个页面所属的账号。`;

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
    document.getElementById('summaryNextCheck').textContent = state.nextScheduledAt
        ? formatDateTime(state.nextScheduledAt)
        : (hasConnection ? '等待排队' : '等待接入');
    document.getElementById('summaryPolicy').textContent = hasConnection
        ? describeScheduleReason(state.nextScheduledReason, state.periodicSyncMinutes)
        : `保底 ${formatMinutesLabel(state.periodicSyncMinutes)}`;
    document.getElementById('summaryLastSync').textContent = formatDateTime(lastSync?.syncedAt);
    document.getElementById('summaryMessage').textContent = buildSummaryMessage({
        hasConnection,
        lastSync,
        periodicSyncMinutes: state.periodicSyncMinutes,
        nextScheduledAt: state.nextScheduledAt,
        nextScheduledReason: state.nextScheduledReason
    });
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
    const periodicLabel = formatMinutesLabel(state.periodicSyncMinutes);

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
            text: `Google Labs 登录态有变化时，扩展会自动同步到 Flow2API；没有明显变化时，后台也会最多每 ${periodicLabel} 保底重刷一次。`,
            actionLabel: '立即重新同步',
            actionNote: '只有在你刚切换 Labs 账号，或者想立刻刷新时，才需要点这一下。'
        };
    }

    if (lastSync?.status === 'detected_session') {
        return {
            title: '检测到当前账号',
            text: lastSync.email
                ? '这个账号已经在当前页面里识别到了，但还没有把它对应到这次同步记录。'
                : '当前页面里的 Google Labs 会话已经识别到，点一下就会立即把这个账号同步到 Flow2API。',
            actionLabel: '同步这个账号',
            actionNote: '这一步只会同步你当前这个页面里的账号，不会沿用别的账号缓存。'
        };
    }

    return {
        title: '等你在这个 Profile 登录 Labs',
        text: 'Flow2API 已经接入。你在这个 Profile 登录 Google Labs 后，扩展会自动完成同步。',
        actionLabel: '同步这个 Profile',
        actionNote: `如果你刚刚登录完成，点一下就会立刻检查；否则后台也会最多每 ${periodicLabel} 自动重试。`
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
        const cookieStoreId = await getCurrentCookieStoreId();

        setBusy(true);
        showStatus('正在连接 Flow2API...', 'info');

        await ensureHostPermission(originPattern);

        const response = await extensionApi.runtime.sendMessage({
            action: 'connectBaseUrl',
            baseUrl,
            cookieStoreId
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
        const cookieStoreId = await getCurrentCookieStoreId();

        setBusy(true);
        showStatus('正在检查当前 Profile 的 Google Labs 登录态...', 'info');

        await ensureHostPermission(originPattern);

        let response;

        if (!state.baseUrl || state.baseUrl !== normalizedBaseUrl || !state.hasConnection) {
            response = await extensionApi.runtime.sendMessage({
                action: 'connectBaseUrl',
                baseUrl: normalizedBaseUrl,
                cookieStoreId
            });
        } else {
            response = await extensionApi.runtime.sendMessage({
                action: 'syncNow',
                cookieStoreId
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
        const cookieStoreId = await getCurrentCookieStoreId();
        if (!baseUrl) {
            throw new Error('请先填写 Flow2API 地址');
        }

        await extensionApi.runtime.sendMessage({
            action: 'openConsole',
            baseUrl,
            cookieStoreId
        });

        showStatus('已打开 Flow2API 控制台', 'info');
    } catch (error) {
        showStatus(error.message, 'error');
    }
}

async function refreshStatus() {
    try {
        setBusy(true);
        showStatus('正在刷新当前 Profile 的状态...', 'info');

        const cookieStoreId = await getCurrentCookieStoreId();
        const response = await extensionApi.runtime.sendMessage({
            action: 'getSetupData',
            cookieStoreId,
            previewCurrentSession: true,
            refreshConnection: true,
            allowSessionMetadataLookup: true
        });

        if (!response?.success) {
            throw new Error(response?.error || '刷新状态失败');
        }

        applySetupResponse(response);
        render(true);
        showStatusForCurrentState();
    } catch (error) {
        showStatus(error.message || '刷新状态失败', 'error');
    } finally {
        setBusy(false);
    }
}

async function updateSyncPreferences(event) {
    const requestedMinutes = normalizePeriodicSyncMinutes(Number(event.target.value));

    try {
        setBusy(true);
        showStatus(`正在把后台保底刷新改成每 ${formatMinutesLabel(requestedMinutes)}...`, 'info');

        const cookieStoreId = await getCurrentCookieStoreId();
        const response = await extensionApi.runtime.sendMessage({
            action: 'updateSyncPreferences',
            cookieStoreId,
            periodicSyncMinutes: requestedMinutes
        });

        if (!response?.success) {
            throw new Error(response?.error || '更新后台刷新策略失败');
        }

        applySetupResponse(response);
        render(true);
        showStatus(`后台保底刷新已改成每 ${formatMinutesLabel(state.periodicSyncMinutes)}。`, 'success');
    } catch (error) {
        renderPreferences();
        showStatus(error.message || '更新后台刷新策略失败', 'error');
    } finally {
        setBusy(false);
    }
}

async function openLogs() {
    const logsUrl = extensionApi.runtime?.getURL
        ? extensionApi.runtime.getURL('logs.html')
        : 'logs.html';

    try {
        if (extensionApi.tabs?.create) {
            await extensionApi.tabs.create({ url: logsUrl });
        } else {
            window.location.href = logsUrl;
        }

        showStatus('已打开诊断日志页', 'info');
    } catch (error) {
        showStatus(error.message || '打开诊断日志失败', 'error');
    }
}

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

async function ensureHostPermission(originPattern) {
    if (!extensionApi.permissions?.contains) {
        return;
    }

    const approved = await extensionApi.permissions.contains({
        origins: [originPattern]
    });

    if (approved) {
        return;
    }

    if (extensionApi.permissions?.request) {
        const requested = await extensionApi.permissions.request({
            origins: [originPattern]
        });

        if (requested) {
            return;
        }
    }

    throw new Error('请在扩展详情里允许访问这个 Flow2API 站点，或把站点访问改成“在所有网站上”后重试');
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
    document.getElementById('periodicSyncMinutes').disabled = isBusy;
    document.getElementById('refreshStatusBtn').disabled = isBusy;
    document.getElementById('consoleBtn').disabled = isBusy || !hasConsoleTarget();
    document.getElementById('logsBtn').disabled = isBusy;
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

function formatMinutesLabel(minutes) {
    const normalized = normalizePeriodicSyncMinutes(minutes);
    if (normalized % 60 === 0) {
        return `${normalized / 60} 小时`;
    }

    return `${normalized} 分钟`;
}

function normalizePeriodicSyncMinutes(value) {
    if (!Number.isFinite(value)) {
        return 240;
    }

    return Math.min(720, Math.max(60, Math.round(value)));
}

function describeScheduleReason(reason, periodicSyncMinutes) {
    switch (reason) {
        case 'account_expiry':
            return '按账号到期提前刷新';
        case 'heuristic_probe':
            return '按活跃度提前试探';
        case 'waiting_session':
            return '等待登录后短间隔重试';
        case 'periodic':
        default:
            return `保底 ${formatMinutesLabel(periodicSyncMinutes)}`;
    }
}

function buildSummaryMessage({
    hasConnection,
    lastSync,
    periodicSyncMinutes,
    nextScheduledAt,
    nextScheduledReason
}) {
    if (!hasConnection) {
        return '第一次只要确认一次 Flow2API 地址，后续同步会自动完成。';
    }

    const parts = [];

    if (lastSync?.message) {
        parts.push(lastSync.message);
    } else if (lastSync?.atExpires) {
        parts.push(`当前账号令牌预计在 ${formatDateTime(lastSync.atExpires)} 前后失效，扩展会提前刷新。`);
    } else {
        parts.push(`Flow2API 已接入；没有明显变化时，后台也会最多每 ${formatMinutesLabel(periodicSyncMinutes)} 保底重刷一次。`);
    }

    if (nextScheduledAt) {
        parts.push(`下次后台检查预计在 ${formatDateTime(nextScheduledAt)}，当前策略是${describeScheduleReason(nextScheduledReason, periodicSyncMinutes)}。`);
    }

    return parts.join(' ');
}
