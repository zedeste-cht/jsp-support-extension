import { defineConfig } from '@vscode/test-cli';

const common = {
	version: '1.103.0',
	workspaceFolder: '../jsptest/servlet_maven_demo',
};

export default defineConfig([
	{
		// Built-in index only (no redhat.java in the test instance).
		label: 'index',
		files: 'out/test/vscode/**/*.test.js',
		mocha: { ui: 'tdd', timeout: 60000 },
		...common,
	},
	{
		// Needs redhat.java in JSP_TEST_EXTENSIONS_DIR (default .vscode-test/extensions-jdt).
		label: 'jdt',
		files: 'out/test/vscode-jdt/**/*.test.js',
		mocha: { ui: 'tdd', timeout: 600000 },
		launchArgs: [
			'--extensions-dir', process.env.JSP_TEST_EXTENSIONS_DIR || '.vscode-test/extensions-jdt',
			'--disable-workspace-trust',
		],
		...common,
		workspaceFolder: 'test-fixtures/maven-multi',
	},
]);
