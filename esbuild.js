const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcher = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => console.log('[watch] build started'));
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) { console.error(`    ${location.file}:${location.line}:${location.column}:`); }
			});
			console.log('[watch] build finished');
		});
	},
};

/** Runtime assets loaded from dist/ at run time (not bundled). */
function copyAssets() {
	fs.mkdirSync('dist', { recursive: true });
	const assets = [
		['node_modules/web-tree-sitter/tree-sitter.wasm', 'dist/tree-sitter.wasm'],
		['resources/tree-sitter-java.wasm', 'dist/tree-sitter-java.wasm'],
		// TypeScript is required lazily on the first JavaScript lookup.
		['node_modules/typescript/lib/typescript.js', 'dist/typescript.js'],
	];
	for (const [from, to] of assets) {
		fs.copyFileSync(path.resolve(from), path.resolve(to));
	}
}

async function main() {
	copyAssets();
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		external: ['vscode'],
		// Prefer ESM builds: the UMD build of vscode-html-languageservice uses dynamic requires.
		mainFields: ['module', 'main'],
		// web-tree-sitter calls createRequire(import.meta.url), which is undefined in CJS.
		define: { 'import.meta.url': '__importMetaUrl' },
		banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
		logLevel: 'silent',
		plugins: [problemMatcher],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
