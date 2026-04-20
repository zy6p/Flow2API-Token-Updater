const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPopupHelpers() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'popup.js'),
        'utf8'
    );

    const element = () => ({
        value: '',
        textContent: '',
        disabled: false,
        addEventListener() {},
        focus() {}
    });

    const context = {
        console,
        setTimeout,
        clearTimeout,
        URL,
        document: {
            activeElement: null,
            addEventListener() {},
            getElementById() {
                return element();
            }
        },
        browser: {
            runtime: {
                sendMessage: async () => ({ success: true })
            },
            tabs: {
                query: async () => []
            }
        }
    };
    context.globalThis = context;

    vm.runInNewContext(source, context, {
        filename: 'popup.js'
    });

    return context;
}

test('shouldShowSetupPanel keeps setup visible until a saved login exists', () => {
    const popup = loadPopupHelpers();

    assert.equal(
        popup.shouldShowSetupPanel({
            hasConnectionToken: false,
            showSetup: false
        }),
        true
    );

    assert.equal(
        popup.shouldShowSetupPanel({
            hasConnectionToken: true,
            showSetup: false
        }),
        false
    );

    assert.equal(
        popup.shouldShowSetupPanel({
            hasConnectionToken: true,
            showSetup: true
        }),
        true
    );
});

test('shouldAutoSyncOnOpen only runs when the popup is already connected', () => {
    const popup = loadPopupHelpers();

    assert.equal(
        popup.shouldAutoSyncOnOpen({
            hasConnectionToken: false,
            baseUrl: 'https://banana.hotdry.top'
        }),
        false
    );

    assert.equal(
        popup.shouldAutoSyncOnOpen({
            hasConnectionToken: true,
            baseUrl: ''
        }),
        false
    );

    assert.equal(
        popup.shouldAutoSyncOnOpen({
            hasConnectionToken: true,
            baseUrl: 'https://banana.hotdry.top'
        }),
        true
    );
});

test('connectFlow2Api requests host permission before resolving the current cookie store', () => {
    const popup = loadPopupHelpers();
    const source = popup.connectFlow2Api.toString();

    assert.ok(
        source.indexOf('await ensureHostPermission(originPattern);')
            < source.indexOf('const cookieStoreId = await getCurrentCookieStoreId();')
    );
});

test('syncCurrentProfile requests host permission before resolving the current cookie store', () => {
    const popup = loadPopupHelpers();
    const source = popup.syncCurrentProfile.toString();

    assert.ok(
        source.indexOf('await ensureHostPermission(originPattern);')
            < source.indexOf('const cookieStoreId = await getCurrentCookieStoreId();')
    );
});
