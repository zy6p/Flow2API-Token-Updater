#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SIGNATURE_ENTRY_PATTERNS = [
    /^meta-inf\/cose\.manifest$/i,
    /^meta-inf\/cose\.sig$/i,
    /^meta-inf\/mozilla\.(rsa|sf)$/i,
    /^meta-inf\/manifest\.mf$/i
];

function listZipEntries(filePath) {
    const commands = [
        ['unzip', ['-Z1', filePath]],
        ['zipinfo', ['-1', filePath]]
    ];

    for (const [command, args] of commands) {
        const result = spawnSync(command, args, {
            encoding: 'utf8'
        });

        if (result.status === 0) {
            return `${result.stdout || ''}`
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
        }
    }

    throw new Error('Unable to inspect archive contents; unzip or zipinfo is required.');
}

function hasFirefoxSignatureEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return false;
    }

    return entries.some((entry) => SIGNATURE_ENTRY_PATTERNS.some((pattern) => pattern.test(entry)));
}

function validateGeckoSignedBundle(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
        return {
            valid: false,
            reason: `File not found: ${resolvedPath}`
        };
    }

    const entries = listZipEntries(resolvedPath);
    if (!entries.includes('manifest.json')) {
        return {
            valid: false,
            reason: 'Archive does not contain manifest.json'
        };
    }

    if (!hasFirefoxSignatureEntries(entries)) {
        return {
            valid: false,
            reason: 'Archive does not contain Firefox signature entries under META-INF/'
        };
    }

    return {
        valid: true,
        reason: 'Firefox signature entries found',
        entries
    };
}

if (require.main === module) {
    const targetPath = process.argv[2];
    if (!targetPath) {
        console.error('Usage: validate_gecko_signed_bundle.js <path-to-xpi>');
        process.exit(2);
    }

    try {
        const result = validateGeckoSignedBundle(targetPath);
        if (!result.valid) {
            console.error(result.reason);
            process.exit(1);
        }

        console.log(result.reason);
    } catch (error) {
        console.error(error.message || String(error));
        process.exit(1);
    }
}

module.exports = {
    hasFirefoxSignatureEntries,
    validateGeckoSignedBundle
};
