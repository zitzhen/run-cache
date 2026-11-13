import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const EXCLUDED_ROOT_ENTRIES = new Set(['.git', '.build', 'out', 'src']);

function isWithin(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function findNodeModules(sourceRoot, relativeDirectory, result) {
	const absoluteDirectory = path.join(sourceRoot, relativeDirectory);
	for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
		if (relativeDirectory === '' && EXCLUDED_ROOT_ENTRIES.has(entry.name)) {
			continue;
		}

		const relativePath = path.join(relativeDirectory, entry.name);
		let stat;
		try {
			stat = fs.statSync(path.join(sourceRoot, relativePath));
		} catch {
			continue;
		}

		if (!stat.isDirectory()) {
			continue;
		}
		if (entry.name === 'node_modules') {
			result.push(relativePath);
			continue;
		}
		findNodeModules(sourceRoot, relativePath, result);
	}
}

function inspectTarget(targetRoot) {
	let fileCount = 0;
	let totalBytes = 0;
	const oversizedFiles = [];

	function visit(relativeDirectory) {
		const absoluteDirectory = path.join(targetRoot, relativeDirectory);
		for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
			const relativePath = path.join(relativeDirectory, entry.name);
			const stat = fs.lstatSync(path.join(targetRoot, relativePath));
			if (stat.isDirectory()) {
				visit(relativePath);
				continue;
			}

			fileCount++;
			if (!stat.isFile()) {
				continue;
			}
			totalBytes += stat.size;
			if (stat.size > MAX_FILE_SIZE) {
				oversizedFiles.push(`${relativePath} (${stat.size} bytes)`);
			}
		}
	}

	visit('');
	return { fileCount, totalBytes, oversizedFiles };
}

function main() {
	const [sourceArgument, targetArgument, platformKey] = process.argv.slice(2);
	if (!sourceArgument || !targetArgument || !platformKey) {
		throw new Error('Usage: node sync-node-modules.mjs <source> <target> <platform-key>');
	}

	const source = path.resolve(sourceArgument);
	const target = path.resolve(targetArgument);
	if (!fs.statSync(source).isDirectory()) {
		throw new Error(`Source is not a directory: ${source}`);
	}
	if (isWithin(source, target) || isWithin(target, source)) {
		throw new Error('Source and target must be separate, non-nested directories.');
	}

	const packageLock = fs.readFileSync(path.join(source, 'package-lock.json'));
	const sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	}).trim();
	const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const npmVersion = execFileSync(npmCommand, ['--version'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	}).trim();

	const nodeModulesDirectories = [];
	findNodeModules(source, '', nodeModulesDirectories);
	if (nodeModulesDirectories.length === 0) {
		throw new Error(`No node_modules directories found in ${source}`);
	}

	fs.rmSync(target, { recursive: true, force: true });
	fs.mkdirSync(target, { recursive: true });
	for (const relativeDirectory of nodeModulesDirectories) {
		const destination = path.join(target, relativeDirectory);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.cpSync(path.join(source, relativeDirectory), destination, {
			recursive: true,
			dereference: false,
			verbatimSymlinks: true,
		});
	}

	const { fileCount, totalBytes, oversizedFiles } = inspectTarget(target);
	if (oversizedFiles.length > 0) {
		throw new Error(`Files exceeding GitHub's 100 MiB limit:\n${oversizedFiles.join('\n')}`);
	}

	const metadata = {
		sourceRepository: 'zitzhen/BlockIDE',
		sourceCommit,
		platformKey,
		nodeVersion: process.version,
		npmVersion,
		packageLockSha256: createHash('sha256').update(packageLock).digest('hex'),
	};
	fs.writeFileSync(path.join(target, 'cache.json'), `${JSON.stringify(metadata, null, 2)}\n`);

	console.log(JSON.stringify({
		platformKey,
		nodeModulesDirectories: nodeModulesDirectories.length,
		files: fileCount,
		totalBytes,
	}, null, 2));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.stack : error);
	process.exitCode = 1;
}
