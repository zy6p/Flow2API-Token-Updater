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

test('shouldPersistGlobalConfigBeforeSync persists a freshly entered connection token even when a saved token already exists', () => {
    const popup = loadPopupHelpers();

    assert.equal(
        popup.shouldPersistGlobalConfigBeforeSync({
            currentBaseUrl: 'https://banana.hotdry.top',
            requestedBaseUrl: 'https://banana.hotdry.top',
            hasSavedConnectionToken: true,
            connectionTokenOverride: '5MK8vfKldWqLSSwMvqhVK3LNbv8iLnKm'
        }),
        true
    );

    assert.equal(
        popup.shouldPersistGlobalConfigBeforeSync({
            currentBaseUrl: 'https://banana.hotdry.top',
            requestedBaseUrl: 'https://banana.hotdry.top',
            hasSavedConnectionToken: true,
            connectionTokenOverride: ''
        }),
        false
    );
});
