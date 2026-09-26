#!/usr/bin/env node
/**
 * Fail if an application's small gateway contract and release helpers drift.
 *
 * The gateway server runs from one SR-Infra image. Web hooks still need the
 * signed-identity and route-decision contract during their own isolated build.
 * Those copied files are hash-checked here until the contract is separately
 * versioned. The app also keeps its web-slot release helper.
 *
 * deploy/kit.json records the version and SHA-256 of each copied file.
 *
 * Run from the application repo root. Run with --update after a deliberate upgrade.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const manifestPath = 'deploy/kit.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const update = process.argv.includes('--update');

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const drifted = [];
for (const [file, expected] of Object.entries(manifest.files)) {
	let actual;
	try {
		actual = digest(file);
	} catch {
		drifted.push(`${file} is missing`);
		continue;
	}
	if (actual !== expected) {
		if (update) manifest.files[file] = actual;
		else drifted.push(`${file} has changed (recorded ${expected.slice(0, 12)}, found ${actual.slice(0, 12)})`);
	}
}

if (update) {
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Recorded the current contract as kit ${manifest.version}.`);
	process.exit(0);
}

if (drifted.length) {
	console.error(
		`SR-Infra contract kit ${manifest.version} has drifted:\n` +
			drifted.map((d) => `  - ${d}`).join('\n') +
			`\n\nEither restore the file from SR-Infra, or — if the change is deliberate — make it in\n` +
			`SR-Infra first, copy the new contract, and run this script with --update.`
	);
	process.exit(1);
}

console.log(`SR-Infra contract kit ${manifest.version} matches.`);
