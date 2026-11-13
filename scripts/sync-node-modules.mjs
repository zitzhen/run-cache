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

function toPosixPath(relativePath) {
	return relativePath.split(path.sep).join('/');
}

function hashFile(absolutePath) {
	const hash = createHash('sha256');
	const fileHandle = fs.openSync(absolutePath, 'r');
	const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
	try {
		let bytesRead;
		while ((bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.length, null)) > 0) {
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		fs.closeSync(fileHandle);
	}
	return hash.digest('hex');
}

function buildAssetName(relativePath) {
	const baseName = path.posix.basename(relativePath).replace(/[^A-Za-z0-9._-]/g, '_');
	const digest = createHash('sha256').update(relativePath).digest('hex').slice(0, 12);
	return `${baseName}.${digest}`;
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

function extractOversizedFiles(targetRoot, stagingRoot) {
	let fileCount = 0;
	let totalBytes = 0;
	let oversizedBytes = 0;
	const oversizedFiles = [];

	function visit(relativeDirectory) {
		const absoluteDirectory = path.join(targetRoot, relativeDirectory);
		for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
			const relativePath = path.join(relativeDirectory, entry.name);
			const absolutePath = path.join(targetRoot, relativePath);
			const stat = fs.lstatSync(absolutePath);
			if (stat.isDirectory()) {
				visit(relativePath);
				continue;
			}
			if (!stat.isFile()) {
				fileCount++;
				continue;
			}

			if (stat.size > MAX_FILE_SIZE) {
				const assetName = buildAssetName(toPosixPath(relativePath));
				oversizedFiles.push({
					path: toPosixPath(relativePath),
					size: stat.size,
					sha256: hashFile(absolutePath),
					assetName,
				});
				oversizedBytes += stat.size;
				fs.renameSync(absolutePath, path.join(stagingRoot, assetName));
				continue;
			}

			fileCount++;
			totalBytes += stat.size;
		}
	}

	visit('');
	oversizedFiles.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

	const seenAssetNames = new Set();
	for (const file of oversizedFiles) {
		if (seenAssetNames.has(file.assetName)) {
			throw new Error(`Duplicate release asset name: ${file.assetName}`);
		}
		seenAssetNames.add(file.assetName);
	}

	return { fileCount, totalBytes, oversizedFiles, oversizedBytes };
}

function main() {
	const [sourceArgument, targetArgument, platformKey, stagingArgument] = process.argv.slice(2);
	if (!sourceArgument || !targetArgument || !platformKey || !stagingArgument) {
		throw new Error('Usage: node sync-node-modules.mjs <source> <target> <platform-key> <oversized-staging-directory>');
	}

	const source = path.resolve(sourceArgument);
	const target = path.resolve(targetArgument);
	const staging = path.resolve(stagingArgument);
	if (!fs.statSync(source).isDirectory()) {
		throw new Error(`Source is not a directory: ${source}`);
	}
	if (isWithin(source, target) || isWithin(target, source)) {
		throw new Error('Source and target must be separate, non-nested directories.');
	}
	if (isWithin(source, staging) || isWithin(staging, source) || isWithin(target, staging) || isWithin(staging, target)) {
		throw new Error('Oversized staging directory must be separate and non-nested.');
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

	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });

	const { fileCount, totalBytes, oversizedFiles, oversizedBytes } = extractOversizedFiles(target, staging);

	const metadata = {
		sourceRepository: 'zitzhen/BlockIDE',
		sourceCommit,
		platformKey,
		nodeVersion: process.version,
		npmVersion,
		packageLockSha256: createHash('sha256').update(packageLock).digest('hex'),
		oversizedReleaseTag: `blockide-node-modules-${platformKey}`,
		oversizedFiles,
	};
	fs.writeFileSync(path.join(target, 'cache.json'), `${JSON.stringify(metadata, null, 2)}\n`);

	console.log(JSON.stringify({
		platformKey,
		nodeModulesDirectories: nodeModulesDirectories.length,
		files: fileCount,
		totalBytes,
		oversizedFileCount: oversizedFiles.length,
		oversizedBytes,
	}, null, 2));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.stack : error);
	process.exitCode = 1;
}
