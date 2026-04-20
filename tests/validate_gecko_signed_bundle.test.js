const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
    hasFirefoxSignatureEntries,
    validateGeckoSignedBundle
} = require('../scripts/validate_gecko_signed_bundle.js');

function createZip(entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow2api-gecko-signature-'));
    const zipPath = path.join(root, 'bundle.xpi');

    for (const [relativePath, contents] of Object.entries(entries)) {
        const absolutePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, contents);
    }

    const result = spawnSync('zip', ['-qr', zipPath, ...Object.keys(entries)], {
        cwd: root,
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || 'zip failed');
    }

    return {
        zipPath,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

test('hasFirefoxSignatureEntries recognises Firefox signature markers', () => {
    assert.equal(hasFirefoxSignatureEntries(['manifest.json']), false);
    assert.equal(hasFirefoxSignatureEntries(['META-INF/cose.sig', 'manifest.json']), true);
    assert.equal(hasFirefoxSignatureEntries(['META-INF/mozilla.rsa', 'manifest.json']), true);
});

test('validateGeckoSignedBundle rejects unsigned bundle contents', () => {
    const archive = createZip({
        'manifest.json': '{}'
    });

    try {
        const result = validateGeckoSignedBundle(archive.zipPath);
        assert.equal(result.valid, false);
        assert.match(result.reason, /does not contain Firefox signature entries/i);
    } finally {
        archive.cleanup();
    }
});

test('validateGeckoSignedBundle accepts bundle with signature markers', () => {
    const archive = createZip({
        'manifest.json': '{}',
        'META-INF/cose.manifest': 'manifest',
        'META-INF/cose.sig': 'signature'
    });

    try {
        const result = validateGeckoSignedBundle(archive.zipPath);
        assert.equal(result.valid, true);
    } finally {
        archive.cleanup();
    }
});
