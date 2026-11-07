/**
 * Lists the operation names the output changes against a commit, such as the last release's,
 * for its release notes. A name renamed or removed breaks the calls that import it. Unlike the
 * report `npm run generate` prints against the last output, it gives the same list on every run.
 *
 *     npm run names -- <git ref> [--out DIR]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { type ManifestEntry, nameChanges, reportNameChanges } from './manifest.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { out: { type: 'string', default: 'generated' } },
});
const [ref] = positionals;
if (ref === undefined) {
	throw new Error('Name the commit to compare with, as `npm run names -- <git ref>`, such as the last release.');
}
const out = realpathSync(values.out);
const path = join(out, '_meta', 'operations.json');
// In the output's directory, which may be outside the current one.
const git = (...args: string[]): string =>
	execFileSync('git', args, { cwd: out, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
// Git names a file by its path in the repository, whatever `--out` was relative to.
const tracked = relative(git('rev-parse', '--show-toplevel').trim(), path).split(sep).join('/');
if (tracked.startsWith('..')) {
	throw new Error(`${path} is outside the repository, so no commit has it`);
}
let committed: string;
try {
	committed = git('show', `${ref}:${tracked}`);
} catch (error) {
	const { stderr } = error as { stderr?: unknown };
	const said = typeof stderr === 'string' ? stderr.trim() : '';
	throw new Error(`git can't show ${tracked} at ${ref}${said === '' ? '' : `: ${said}`}`, { cause: error });
}
const before = JSON.parse(committed) as ManifestEntry[];
const after = JSON.parse(readFileSync(path, 'utf8')) as ManifestEntry[];
console.log(reportNameChanges(nameChanges(before, after), ref).join('\n'));
