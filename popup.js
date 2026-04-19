const extensionApi = globalThis.browser ?? globalThis.chrome;

const state = {
    baseUrl: '',
    suggestedBaseUrl: '',
    lastSync: null,
    browserInfo: null,
    hasConnection: false,
    hasAdminToken: false,
    hasCachedConnectionToken: false,
    configSource: 'none',
    periodicSyncMinutes: 240,
    nextScheduledAt: null,
    nextScheduledReason: null,
    storePolicy: 'observe',
    explicitStorePolicy: null
};

let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadSetupData();
});

function bindEvents() {
    document.getElementById('connectBtn').addEventListener('click', runPrimaryAction);
    document.getElementById('periodicSyncMinutes').addEventListener('change', updateSyncPreferences);
    document.getElementById('storePolicy').addEventListener('change', updateStorePolicy);
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
    state.hasAdminToken = Boolean(response.hasAdminToken);
    state.hasCachedConnectionToken = Boolean(response.hasCachedConnectionToken);
    state.configSource = response.settings?.configSource || 'none';
    state.periodicSyncMinutes = normalizePeriodicSyncMinutes(response.settings?.periodicSyncMinutes);
    state.nextScheduledAt = response.settings?.nextScheduledAt || null;
    state.nextScheduledReason = response.settings?.nextScheduledReason || null;
    state.storePolicy = normalizeStorePolicy(response.settings?.storePolicy);
    state.explicitStorePolicy = normalizeStorePolicy(response.settings?.explicitStorePolicy, true);
}

function showStatusForCurrentState() {
    if (state.storePolicy === 'disabled') {
        showStatus('当前 store 已停用自动管理。需要时仍然可以手动同步。', 'info');
    } else if (state.storePolicy === 'observe' && state.hasConnection) {
        showStatus('当前 store 只做轻量跟随，不会主动开后台唤醒页。', 'info');
    } else if (state.lastSync?.status === 'success') {
        showStatus('当前 store 已经由全局配置接管。', 'success');
    } else if (state.lastSync?.status === 'detected_session') {
        showStatus(state.lastSync.message || '检测到当前账号，点一下就可以同步这个账号。', 'info');
    } else if (state.lastSync?.status === 'error') {
        showStatus(state.lastSync.message || '这次同步没有完成。', 'error');
    } else if (state.lastSync?.status === 'waiting_session' || state.hasConnection) {
        showStatus(state.lastSync?.message || '全局控制面已配置，等你在当前 store 登录 Labs。', 'info');
    } else if (state.baseUrl && !state.hasAdminToken) {
        showStatus('还差一个 Flow2API Admin Token，填好后扩展才能全局管理自动刷新。', 'info');
    } else if (state.baseUrl) {
        showStatus('补上 Admin Token 后，就可以让扩展接管自动同步。', 'info');
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

    const adminTokenInput = document.getElementById('adminToken');
    if (!document.activeElement || document.activeElement !== adminTokenInput) {
        adminTokenInput.value = '';
    }
    adminTokenInput.placeholder = state.hasAdminToken
        ? '已保存，留空表示保持不变'
        : '输入后只保存，不会回显';
    document.getElementById('adminTokenHint').textContent = state.hasAdminToken
        ? '已保存全局 Admin Token。留空不会覆盖；重新输入则会更新。'
        : '填一次即可。后续连接 token 会由扩展自动通过 API 获取和刷新。';

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

    const storePolicySelect = document.getElementById('storePolicy');
    const normalizedStorePolicy = normalizeStorePolicy(state.storePolicy);
    if (storePolicySelect.value !== normalizedStorePolicy) {
        storePolicySelect.value = normalizedStorePolicy;
    }

    document.getElementById('storePolicyHint').textContent = describeStorePolicyHint(normalizedStorePolicy);
}

function renderSummary() {
    const browserName = state.browserInfo?.name
        ? `${state.browserInfo.name} ${state.browserInfo.version || ''}`.trim()
        : '当前浏览器';

    document.getElementById('browserHint').textContent =
        `${browserName} 里的真实浏览器 Profile 彼此隔离；当前扩展实例会统一管理这个浏览器 Profile 里的各个 cookie store / container，但不会跨真实 Profile 共享运行状态。`;

    const hasBaseUrl = Boolean(state.baseUrl);
    const hasConnection = Boolean(state.hasConnection);
    const globallyReady = Boolean(state.baseUrl && state.hasAdminToken);
    const lastSync = state.lastSync;

    let stateLabel = '未接入';
    let stateClass = 'waiting';

    if (globallyReady && lastSync?.status === 'error') {
        stateLabel = '需要处理';
        stateClass = 'warning';
    } else if (globallyReady) {
        stateLabel = '已接管';
        stateClass = 'connected';
    } else if (hasBaseUrl && lastSync?.status === 'error') {
        stateLabel = '需要处理';
        stateClass = 'warning';
    } else if (hasBaseUrl && state.hasCachedConnectionToken) {
        stateLabel = '待补配置';
        stateClass = 'waiting';
    } else if (hasBaseUrl) {
        stateLabel = '等待配置';
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
        : describeNextCheckState(hasConnection);
    document.getElementById('summaryPolicy').textContent = describeSummaryPolicy();
    document.getElementById('summaryLastSync').textContent = formatDateTime(lastSync?.syncedAt);
    document.getElementById('summaryMessage').textContent = buildSummaryMessage({
        hasConnection,
        lastSync,
        storePolicy: state.storePolicy,
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
    const globallyReady = Boolean(state.baseUrl && state.hasAdminToken);
    const lastSync = state.lastSync;
    const periodicLabel = formatMinutesLabel(state.periodicSyncMinutes);
    const storeMode = normalizeStorePolicy(state.storePolicy);

    if (!globallyReady) {
        return {
            title: hasBaseUrl ? '补上权限就能接管' : '先配置全局控制面',
            text: hasBaseUrl
                ? '现在还差 Flow2API Admin Token。保存后扩展会直接通过 API 管理连接和自动刷新，不再依赖控制台页。'
                : '先告诉扩展你的 Flow2API 站点和 Admin Token，后续自动同步就不需要你反复操作。',
            actionLabel: '保存全局配置',
            actionNote: '第一次只做一件事：把这个浏览器实例接到你的 Flow2API 控制面。'
        };
    }

    if (storeMode === 'disabled') {
        return {
            title: '当前 store 已停用自动管理',
            text: '这个 store 不会再被后台主动检查，也不会因为 Labs Cookie 变化自动同步。需要时你仍然可以手动同步一次。',
            actionLabel: '手动同步一次',
            actionNote: '如果你不想再看到后台唤醒干扰，就把不重要的 store 设成停用。'
        };
    }

    if (storeMode === 'observe') {
        return {
            title: '当前 store 只做轻量跟随',
            text: '这个 store 会在你自己登录、切换账号或 Cookie 变化时顺手同步，但不会主动开后台唤醒页。',
            actionLabel: '手动同步当前 store',
            actionNote: '适合偶尔才会登录的 store。真正需要零干预的，再切成主动管理。'
        };
    }

    if (lastSync?.status === 'error') {
        return {
            title: '这次同步没有完成',
            text: '全局控制面已经就绪。现在只需要重新检查当前 store 的 Google Labs 登录态。',
            actionLabel: '再试一次',
            actionNote: '点一下只会重新检查当前 store，不会改动别的 store。'
        };
    }

    if (lastSync?.status === 'success') {
        return {
            title: '当前 store 已经就绪',
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
        title: '等你在当前 store 登录 Labs',
        text: '全局控制面已经接入。你在当前 store 登录 Google Labs 后，扩展会自动完成同步。',
        actionLabel: '同步当前 store',
        actionNote: `如果你刚刚登录完成，点一下就会立刻检查；否则后台也会最多每 ${periodicLabel} 自动重试。`
    };
}

async function runPrimaryAction() {
    if (state.hasAdminToken) {
        return syncCurrentProfile();
    }

    return connectFlow2Api();
}

async function connectFlow2Api() {
    try {
        const baseUrl = collectBaseUrl();
        const adminToken = collectAdminToken(true);
        const originPattern = toOriginPattern(baseUrl);
        const cookieStoreId = await getCurrentCookieStoreId();

        setBusy(true);
        showStatus('正在保存 Flow2API 全局配置...', 'info');

        await ensureHostPermission(originPattern);

        const response = await extensionApi.runtime.sendMessage({
            action: 'saveGlobalConfig',
            baseUrl,
            adminToken,
            cookieStoreId
        });

        if (!response?.success) {
            state.baseUrl = normalizeBaseUrl(baseUrl);

            if (response?.lastSync) {
                state.lastSync = response.lastSync;
            }

            render();

            if (response?.needsLogin) {
                showStatus(response.message || '请检查 Flow2API Admin Token 是否有效', 'info');
                return;
            }

            throw new Error(response?.error || '连接失败');
        }

        state.baseUrl = normalizeBaseUrl(baseUrl);
        state.lastSync = response.lastSync || state.lastSync;
        state.hasConnection = true;
        state.hasAdminToken = true;
        state.configSource = 'global';
        render();

        const statusType = response.lastSync?.status === 'error'
            ? 'error'
            : (response.synced === false ? 'info' : 'success');

        showStatus(
            response.message || 'Flow2API 全局控制面已保存。',
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
        showStatus('正在检查当前 store 的 Google Labs 登录态...', 'info');

        await ensureHostPermission(originPattern);

        let response;

        if (!state.baseUrl || state.baseUrl !== normalizedBaseUrl || !state.hasAdminToken) {
            response = await extensionApi.runtime.sendMessage({
                action: 'saveGlobalConfig',
                baseUrl: normalizedBaseUrl,
                adminToken: collectAdminToken(true),
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
                showStatus(response.message || '请检查 Flow2API Admin Token 是否有效', 'info');
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
            response.message || '当前 store 已同步。',
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
        showStatus('正在刷新当前 store 的状态...', 'info');

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

async function updateStorePolicy(event) {
    const requestedPolicy = normalizeStorePolicy(event.target.value);

    try {
        setBusy(true);
        showStatus(`正在把当前 store 改成“${describeStorePolicyLabel(requestedPolicy)}”...`, 'info');

        const cookieStoreId = await getCurrentCookieStoreId();
        const response = await extensionApi.runtime.sendMessage({
            action: 'updateStorePolicy',
            cookieStoreId,
            storePolicy: requestedPolicy
        });

        if (!response?.success) {
            throw new Error(response?.error || '更新当前 store 管理模式失败');
        }

        applySetupResponse(response);
        render(true);
        showStatus(`当前 store 已改成“${describeStorePolicyLabel(state.storePolicy)}”。`, 'success');
    } catch (error) {
        renderPreferences();
        showStatus(error.message || '更新当前 store 管理模式失败', 'error');
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

function collectAdminToken(allowKeepExisting = false) {
    const raw = document.getElementById('adminToken').value.trim();
    if (raw) {
        return raw;
    }

    if (allowKeepExisting && state.hasAdminToken) {
        return '';
    }

    throw new Error('请填写 Flow2API Admin Token');
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
    document.getElementById('adminToken').disabled = isBusy;
    document.getElementById('periodicSyncMinutes').disabled = isBusy;
    document.getElementById('storePolicy').disabled = isBusy;
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

function normalizeStorePolicy(value, allowNull = false) {
    switch (value) {
        case 'auto':
        case 'observe':
        case 'disabled':
            return value;
        default:
            return allowNull ? null : 'observe';
    }
}

function describeScheduleReason(reason, periodicSyncMinutes) {
    switch (reason) {
        case 'account_expiry':
            return '按账号到期提前刷新';
        case 'heuristic_probe':
            return '按活跃度提前试探';
        case 'metadata_retry':
            return '补齐账号过期时间';
        case 'sync_error':
            return '同步失败后快速重试';
        case 'waiting_session':
            return '等待登录后短间隔重试';
        case 'periodic':
        default:
            return `保底 ${formatMinutesLabel(periodicSyncMinutes)}`;
    }
}

function describeStorePolicyLabel(policy) {
    switch (normalizeStorePolicy(policy)) {
        case 'auto':
            return '主动管理';
        case 'disabled':
            return '停用';
        case 'observe':
        default:
            return '轻量跟随';
    }
}

function describeStorePolicyHint(policy) {
    switch (normalizeStorePolicy(policy)) {
        case 'auto':
            return '主动管理：这个 store 会参与定时检查，也允许后台唤醒 Labs 页来自动恢复会话。';
        case 'disabled':
            return '停用：这个 store 完全不参与后台自动检查，也不会跟随 Cookie 变化自动同步。';
        case 'observe':
        default:
            return '轻量跟随：只在你自己登录、切换账号或 Cookie 变化时顺手同步，不主动开后台唤醒页。';
    }
}

function describeNextCheckState(hasConnection) {
    if (!hasConnection) {
        return '等待配置';
    }

    if (state.storePolicy === 'disabled') {
        return '已停用';
    }

    if (state.storePolicy === 'observe') {
        return '按活动跟随';
    }

    return '等待排队';
}

function describeSummaryPolicy() {
    const modeLabel = describeStorePolicyLabel(state.storePolicy);
    if (!state.hasConnection) {
        return modeLabel;
    }

    if (state.storePolicy !== 'auto') {
        return modeLabel;
    }

    return `${modeLabel} · ${describeScheduleReason(state.nextScheduledReason, state.periodicSyncMinutes)}`;
}

function buildSummaryMessage({
    hasConnection,
    lastSync,
    storePolicy,
    periodicSyncMinutes,
    nextScheduledAt,
    nextScheduledReason
}) {
    if (!hasConnection) {
        return '先把 Flow2API 站点和 Admin Token 配好，后续自动同步才会真正接管。';
    }

    if (storePolicy === 'disabled') {
        return '当前 store 已停用自动管理。它不会再被后台主动打扰；需要时再手动同步一次即可。';
    }

    if (storePolicy === 'observe') {
        return '当前 store 处于轻量跟随模式。只有你自己登录、切换账号或 Cookie 变化时，扩展才会顺手同步，不会主动开后台唤醒页。';
    }

    const parts = [];

    if (lastSync?.message) {
        parts.push(lastSync.message);
    } else if (lastSync?.atExpires) {
        parts.push(`当前账号令牌预计在 ${formatDateTime(lastSync.atExpires)} 前后失效，扩展会提前刷新。`);
    } else {
        parts.push(`全局控制面已经接入；没有明显变化时，后台也会最多每 ${formatMinutesLabel(periodicSyncMinutes)} 保底重刷一次。`);
    }

    if (nextScheduledAt) {
        parts.push(`下次后台检查预计在 ${formatDateTime(nextScheduledAt)}，当前策略是${describeScheduleReason(nextScheduledReason, periodicSyncMinutes)}。`);
    }

    return parts.join(' ');
}
