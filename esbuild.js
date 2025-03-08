const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

const commonConfig = {
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
	// Configuration for the extension
	const extensionCtx = await esbuild.context({
		...commonConfig,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		external: ['vscode'],
	});

	// Configuration for the server
	const serverCtx = await esbuild.context({
		...commonConfig,
		entryPoints: ['src/server.ts'],
		outfile: 'dist/server.js',
		bundle: true,
		platform: 'node',
		// Only exclude vscode, include everything else
		external: ['vscode'],
		// Make sure dependencies are included
		nodePaths: ['./node_modules'],
		mainFields: ['module', 'main'],
		resolveExtensions: ['.ts', '.js']
	});

	if (watch) {
		await Promise.all([
			extensionCtx.watch(),
			serverCtx.watch()
		]);
	} else {
		await Promise.all([
			extensionCtx.rebuild(),
			serverCtx.rebuild()
		]);
		await Promise.all([
			extensionCtx.dispose(),
			serverCtx.dispose()
		]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
