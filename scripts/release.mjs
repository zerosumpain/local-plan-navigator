#!/usr/bin/env node
/**
 * Switch an extracted application's live traffic to a slot, and roll back if the
 * switch cannot be proven.
 *
 * Generalised from SR-Policy-Analysis scripts/local-release.mjs, which proved the
 * behaviour locally (routing rollback measured at 11ms while a worker held a lease).
 * The policy production rollout had no automated equivalent — it was a manually
 * transferred image — which is the gap this closes.
 *
 * Usage: release.mjs <config.json> <slot> [--probe <url>]
 *
 *   1. Asks the target slot for /health and reads the release id it reports.
 *   2. Writes routing.json atomically (temp file + rename, so the gateway can never
 *      read a half-written file).
 *   3. Asks the GATEWAY which slot it now thinks is active, and requires the one
 *      just switched to.
 *   4. Re-asks through the public probe URL and requires the SAME release id back.
 *   5. Restores the previous routing.json if any of that fails.
 *
 * It never builds, never starts a container and never touches the database. Start
 * the target slot first; this only moves traffic.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const [configPath, slot, ...rest] = process.argv.slice(2);
if (!configPath || !slot) {
	console.error('Usage: release.mjs <config.json> <slot> [--probe <url>]');
	process.exit(2);
}

const app = JSON.parse(readFileSync(configPath, 'utf8'));
const slots = app.slots;
if (!Object.hasOwn(slots, slot)) {
	console.error(`Choose one of: ${Object.keys(slots).join(', ')}`);
	process.exit(2);
}

const probeIndex = rest.indexOf('--probe');
// Only an EXPLICIT --probe verifies the public path. The config carries the URL
// this app will eventually answer on, which is not the same as a promise that
// the edge routes there yet — falling back to it would make an unrouted app
// compare Main's release header with its own and roll back a good switch.
const probe = probeIndex === -1 ? null : rest[probeIndex + 1];
const releaseHeader = app.releaseHeader ?? `x-${app.name}-release`;
const routingFile = app.routingFile;

const before = readFileSync(routingFile, 'utf8');

const health = await fetch(`http://127.0.0.1:${slots[slot]}${app.livenessPath ?? '/__alive'}`, { signal: AbortSignal.timeout(5000) });
if (!health.ok) throw new Error('Target slot is not ready; routing unchanged');
const status = await health.json();

const previous = Object.keys(slots).find((name) => name !== slot);

function save(value) {
	writeFileSync(`${routingFile}.tmp`, value);
	renameSync(`${routingFile}.tmp`, routingFile);
}

save(`${JSON.stringify({ active: slot, previous })}\n`);

try {
	// Did the gateway actually SEE the switch? This is the invariant, and until
	// 2026-09-13 nothing tested it: compose bind-mounted routing.json as a single
	// FILE, save() replaces it by rename, and a file bind mount follows the
	// original inode — so the gateway read the same content for the life of its
	// container and blue/green switched nothing.
	//
	// The public probe only catches that when the release happens to target the
	// slot the gateway is NOT stuck on, and an app with no --probe (every path
	// owner-only, so no public 200 to compare) never catches it at all. SR-Drive
	// reported a green release while serving the previous image.
	//
	// So ask the gateway directly. No credential, no public URL, no Host header —
	// decide() answers /__gateway/health before it checks either — so this works
	// for every app and tests the thing that actually has to be true.
	const gateway = await fetch(`http://127.0.0.1:${app.port}/__gateway/health`, {
		signal: AbortSignal.timeout(5000)
	});
	if (!gateway.ok) throw new Error(`Gateway did not answer /__gateway/health (${gateway.status})`);
	const seen = await gateway.json();
	if (seen.active !== slot) {
		throw new Error(
			`Gateway still reports active=${seen.active} after the switch to ${slot}. ` +
				'It cannot see routing.json — check that compose mounts the routing DIRECTORY ' +
				'rather than the file, and that the gateway container has been recreated since.'
		);
	}

	if (probe) {
		const response = await fetch(probe, { signal: AbortSignal.timeout(10000) });
		if (!response.ok) throw new Error(`Probe ${probe} returned ${response.status}`);
		const served = response.headers.get(releaseHeader);
		if (served !== status.release) {
			throw new Error(`Probe served release ${served}, expected ${status.release}`);
		}
	}
	console.log(JSON.stringify({ app: app.name, active: slot, previous, release: status.release }));
} catch (error) {
	save(before);
	throw error;
}
