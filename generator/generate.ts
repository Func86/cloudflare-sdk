/**
 * Generates the operations the way the cf CLI generates its commands: a pinned
 * release of Forge's OpenAPI document, prepared, normalized by `forge normalize`,
 * and run through this package's Forge plugin.
 *
 *     npm run generate   # builds the plugin to generator/sdk.wasm, then runs this
 *     node generator/generate.ts [--spec PATH] [--out DIR]
 *
 * `FORGE_OPENAPI_BUNDLE` also names a local document, as it does in cf.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type ManifestEntry, nameChanges, reportNameChanges } from './manifest.ts';
import { prepare } from './prepare.ts';
import type { OpenApiDocument } from './spec.ts';

// Bump this SHA to generate from a new release.
const FORGE_OPENAPI_VERSION = 'debf614f6ff428f3dbb88126efb5584e4e3a6e0b';
const FORGE_OPENAPI_URL = `https://github.com/cloudflare/forge/releases/download/openapi@${FORGE_OPENAPI_VERSION}/openapi.forge.json`;

async function loadDocument(path: string | undefined): Promise<OpenApiDocument> {
	if (path !== undefined) {
		return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument;
	}
	const cached = join('.cache', `openapi.${FORGE_OPENAPI_VERSION}.json`);
	if (!existsSync(cached)) {
		const response = await fetch(FORGE_OPENAPI_URL);
		if (!response.ok) {
			throw new Error(`Failed to fetch ${FORGE_OPENAPI_URL}: ${response.status} ${response.statusText}`);
		}
		mkdirSync('.cache', { recursive: true });
		writeFileSync(cached, await response.text());
	}
	return JSON.parse(readFileSync(cached, 'utf8')) as OpenApiDocument;
}

/** Pipes the document through `forge normalize` into the plugin. */
async function runForge(document: string, plugin: string, out: string): Promise<void> {
	const forgeBin = join(
		dirname(createRequire(import.meta.url).resolve('@cloudflare/forge/package.json')),
		'bin',
		'forge.cjs',
	);
	const normalize = spawn(process.execPath, [forgeBin, 'normalize', '--leave-old-extensions', '-'], {
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	const forge = spawn(process.execPath, [forgeBin, '-', '--target', `wasm://${plugin}`, '--out', out], {
		stdio: ['pipe', 'inherit', 'inherit'],
	});
	let transferError: unknown;
	const transfer = Promise.all([
		pipeline(Readable.from([document]), normalize.stdin),
		pipeline(normalize.stdout, forge.stdin),
	]).catch((error: unknown) => {
		transferError = error;
	});
	const closed = (child: ChildProcess): Promise<[code: number | null]> => once(child, 'close') as Promise<[number | null]>;
	const [[normalizeCode], [forgeCode]] = await Promise.all([closed(normalize), closed(forge), transfer]);
	if (normalizeCode !== 0) {
		throw new Error(`forge normalize exited with ${String(normalizeCode)}`);
	}
	if (forgeCode !== 0) {
		throw new Error(`forge exited with ${String(forgeCode)}`);
	}
	if (transferError !== undefined) {
		throw new Error('piping the document into forge failed', { cause: transferError });
	}
}

function sizes(directory: string): { files: number; scripts: number; declarations: number } {
	const total = { files: 0, scripts: 0, declarations: 0 };
	for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || entry.parentPath.includes('_meta')) {
			continue;
		}
		const bytes = statSync(join(entry.parentPath, entry.name)).size;
		total.files += 1;
		if (entry.name.endsWith('.d.ts')) {
			total.declarations += bytes;
		} else {
			total.scripts += bytes;
		}
	}
	return total;
}

const { values } = parseArgs({
	options: {
		spec: { type: 'string' },
		out: { type: 'string', default: 'generated' },
	},
});

const plugin = fileURLToPath(new URL('./sdk.wasm', import.meta.url));
if (!existsSync(plugin)) {
	throw new Error(`${plugin} is missing; run \`npm run generate\`, which builds the plugin first`);
}

const started = performance.now();
const doc = await loadDocument(values.spec ?? process.env['FORGE_OPENAPI_BUNDLE']);
const { skipped, flags, restatedRequired } = prepare(doc);

const out = values.out.replace(/[\\/]+$/, '');
const manifestPath = join(out, '_meta', 'operations.json');
const previous = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[]) : undefined;
// Beside it first, so a failure in Forge or the plugin leaves the last output whole.
const partial = `${out}.partial`;
rmSync(partial, { recursive: true, force: true });
try {
	await runForge(JSON.stringify(doc), plugin, partial);
	// A plugin built before the generator's last change writes a report without what it reads.
	const written = JSON.parse(readFileSync(join(partial, '_meta', 'report.json'), 'utf8')) as Record<string, unknown>;
	if (typeof written['naming'] !== 'object' || written['naming'] === null) {
		throw new Error(`${plugin} is older than the generator; run \`npm run generate\`, which builds the plugin first`);
	}
} catch (error) {
	rmSync(partial, { recursive: true, force: true });
	throw error;
}
rmSync(out, { recursive: true, force: true });
renameSync(partial, out);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as (ManifestEntry & { page?: unknown })[];
const report = JSON.parse(readFileSync(join(out, '_meta', 'report.json'), 'utf8')) as {
	pagination: Record<string, string[]>;
	naming: Record<string, string[]>;
};
const counts = (reasons: Record<string, string[]>): string =>
	Object.entries(reasons)
		.map(([reason, keys]) => `${reason}: ${keys.length}`)
		.join('; ') || 'none';
const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const total = sizes(out);
console.log(`${manifest.length} operations, ${manifest.filter((operation) => operation.page).length} paginated`);
console.log(`skipped before Forge: ${JSON.stringify(skipped)}`);
console.log(`flags moved: ${JSON.stringify(flags)}; required restated: ${restatedRequired}`);
console.log(`not paginated, needs a look: ${counts(report.pagination)}`);
console.log(`names that need a look, in _meta/report.json: ${counts(report.naming)}`);
if (previous !== undefined) {
	// Against a release instead, which a second run would lose: `npm run names -- <git ref>`.
	console.log(reportNameChanges(nameChanges(previous, manifest), 'the last output').join('\n'));
}
console.log(`${total.files} files: ${megabytes(total.scripts)} js, ${megabytes(total.declarations)} d.ts`);
console.log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
