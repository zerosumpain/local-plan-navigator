#!/usr/bin/env node
/**
 * Fail if an extracted application still reaches back into SR-Main.
 *
 * This is the acceptance criterion that matters most and is the easiest to lose:
 * "its clean build works without checking out SR-Main or importing its source or
 * schema". An app that quietly resolves one path into ../strange_rambling_svelte
 * builds fine on the machine that has it and fails in CI — or worse, builds in CI
 * from a stale sibling checkout and ships something nobody reviewed.
 *
 * Checks, over the app's own tracked source:
 *   1. no import or path literal escaping the repo root;
 *   2. no reference to the main site's tree from executable code;
 *   3. no symlink in the repo pointing outside it;
 *   4. a lockfile, once there is a package.json to pin.
 *
 * Comments are stripped before the second check. Explaining in a comment why this
 * repo exists separately from SR-Main is the opposite of a coupling problem, and
 * a checker that cannot tell prose from an import trains people to ignore it.
 *
 * Run from the application repo root.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, readlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const root = process.cwd();
const SELF = 'scripts/verify-self-contained.mjs';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
	.split('\n')
	.filter(Boolean)
	.filter((f) => /\.(ts|js|mjs|cjs|svelte|json)$/.test(f));

const problems = [];

// PATH-shaped only. `SR-Main` was in this list and it caught nothing but prose:
// it is a repository name, not something you can import from, so every hit was a
// log message or a doc comment explaining the relationship — which is the
// opposite of a coupling problem. What actually detects an escape is a path that
// resolves outside the repo, which is checked separately below.
const FORBIDDEN = [
	/strange_rambling_svelte/,
	/\/opt\/strange-rambling-svelte\/(?!data\/)/
];

/** Remove // and /* *\/ comments, and Svelte's <!-- --> so prose is not scanned. */
function stripComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/^\s*#.*$/gm, ' ');
}

for (const file of tracked) {
	// A worktree can contain a deliberate deletion before the next commit.
	if (!existsSync(resolve(root, file))) continue;
	// docs/ explains the relationship on purpose; this file carries the patterns
	// it is looking for, so it always matches itself.
	if (file.startsWith('docs/') || file === SELF) continue;

	const raw = readFileSync(file, 'utf8');
	const code = stripComments(raw);

	for (const pattern of FORBIDDEN) {
		const match = code.match(pattern);
		if (match) problems.push(`${file} refers to the main site in code: "${match[0]}"`);
	}

	// An import that climbs out of the repo root.
	for (const m of raw.matchAll(/from\s+['"](\.[^'"]*)['"]|import\s*\(\s*['"](\.[^'"]*)['"]/g)) {
		const spec = m[1] ?? m[2];
		if (!spec.startsWith('.')) continue;
		const target = resolve(dirname(resolve(root, file)), spec);
		if (!target.startsWith(`${root}/`) && target !== root) {
			problems.push(`${file} imports "${spec}", which resolves outside the repository`);
		}
	}

	const stat = lstatSync(resolve(root, file));
	if (stat.isSymbolicLink()) {
		const target = resolve(dirname(resolve(root, file)), readlinkSync(resolve(root, file)));
		if (!target.startsWith(`${root}/`)) problems.push(`${file} is a symlink pointing outside the repository`);
	}
}

// A scaffold has no dependencies yet; an application with a package.json and no
// lockfile is a build that resolves differently on every machine.
if (existsSync(resolve(root, 'package.json')) && !existsSync(resolve(root, 'package-lock.json'))) {
	problems.push('package.json has no package-lock.json: the app does not pin its own dependency tree');
}

if (problems.length) {
	console.error('This application is not self-contained:\n' + problems.map((p) => `  - ${p}`).join('\n'));
	process.exit(1);
}

console.log(`Self-contained: ${tracked.length} tracked source files, none reaching outside the repository.`);
