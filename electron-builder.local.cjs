// Distinct artifact and version for local changes, without editing the upstream version.
const { execFileSync } = require('node:child_process');
const { version, build } = require('./package.json');
const revision = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
	cwd: __dirname,
	encoding: 'utf8',
}).trim();

module.exports = {
	...build,
	directories: { ...build.directories, output: 'release/local' },
	extraMetadata: { version: `${version}-local.${revision}` },
	publish: null,
};
