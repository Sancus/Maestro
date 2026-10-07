/**
 * @file auto-updater.test.ts
 * @description Tests for the electron-updater integration in src/main/auto-updater.ts.
 *
 * Focused on the `updates:install` IPC handler - specifically that it invokes
 * the optional `onBeforeQuitAndInstall` hook before calling
 * `autoUpdater.quitAndInstall()`. This hook is what lets the host bypass the
 * busy-agent quit confirmation gate so the Windows installer (which spawns
 * waiting on our PID) isn't orphaned by `before-quit` preventDefault.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture IPC handler registrations so we can invoke them from tests.
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockHandle = vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
	ipcHandlers.set(channel, fn);
});

vi.mock('electron', () => ({
	app: { getVersion: () => mockVersion },
	BrowserWindow: class {},
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => mockHandle(channel, fn),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => false),
}));

const mockCaptureException = vi.fn().mockResolvedValue(undefined);
vi.mock('../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// electron-updater is loaded via dynamic `require` inside auto-updater.ts to
// defer electron.app access - that bypasses vitest's module mocker. We use the
// __setAutoUpdaterForTesting escape hatch instead.
const mockAutoUpdater = {
	autoDownload: false,
	autoInstallOnAppQuit: false,
	allowPrerelease: false,
	on: vi.fn(),
	checkForUpdates: vi.fn(),
	downloadUpdate: vi.fn(),
	quitAndInstall: vi.fn(),
	setFeedURL: vi.fn(),
};

let mockVersion = '0.18.9-RC';

describe('main/auto-updater', () => {
	beforeEach(() => {
		mockVersion = '0.18.9-RC';
		vi.clearAllMocks();
		vi.resetModules();
		ipcHandlers.clear();
		mockAutoUpdater.quitAndInstall.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(['0.18.9-RC-local.abc12345', '0.18.9-RC-sancus.22.1'])(
		'blocks official update operations for custom build %s',
		async (version) => {
			mockVersion = version;
			const { initAutoUpdater, __setAutoUpdaterForTesting, checkForUpdatesManual } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			mockAutoUpdater.autoInstallOnAppQuit = true;
			const beforeInstall = vi.fn();
			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall: beforeInstall,
			});
			for (const channel of ['updates:checkAutoUpdater', 'updates:download', 'updates:install']) {
				expect(await ipcHandlers.get(channel)!()).toEqual({
					success: false,
					error: expect.stringContaining('disabled for this custom build'),
				});
			}
			expect(await checkForUpdatesManual()).toBeNull();
			expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
			expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
			expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
			expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
			expect(beforeInstall).not.toHaveBeenCalled();
		}
	);

	describe('updates:install handler', () => {
		it('invokes onBeforeQuitAndInstall before quitAndInstall', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			const callOrder: string[] = [];
			const onBeforeQuitAndInstall = vi.fn(() => {
				callOrder.push('onBeforeQuitAndInstall');
			});
			mockAutoUpdater.quitAndInstall.mockImplementation(() => {
				callOrder.push('quitAndInstall');
			});

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall,
			});

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			await installHandler!();

			expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
			expect(callOrder).toEqual(['onBeforeQuitAndInstall', 'quitAndInstall']);
		});

		it('still calls quitAndInstall when no onBeforeQuitAndInstall is provided', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0]);

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			await installHandler!();

			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
		});

		it('still calls quitAndInstall if onBeforeQuitAndInstall throws and reports to Sentry', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			const hookError = new Error('hook blew up');
			const onBeforeQuitAndInstall = vi.fn(() => {
				throw hookError;
			});

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall,
			});

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			expect(() => installHandler!()).not.toThrow();

			expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
			expect(mockCaptureException).toHaveBeenCalledWith(
				hookError,
				expect.objectContaining({
					module: 'AutoUpdater',
					hook: 'onBeforeQuitAndInstall',
					operation: 'updates:install',
				})
			);
		});

		it('wraps non-Error throws from onBeforeQuitAndInstall before reporting to Sentry', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			const onBeforeQuitAndInstall = vi.fn(() => {
				// eslint-disable-next-line @typescript-eslint/only-throw-error
				throw 'string-thrown';
			});

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall,
			});

			const installHandler = ipcHandlers.get('updates:install');
			installHandler!();

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'string-thrown' }),
				expect.any(Object)
			);
			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
		});
	});

	describe('updates:download handler - transient retry + error sanitization', () => {
		// The raw blob electron-updater throws on a GitHub 504: an HTTP status,
		// an HTML error page, and a dump of response headers + cookies.
		const raw504 =
			'504 "method: GET url: https://github.com/RunMaestro/Maestro/releases.atom\n\n' +
			' Data:\n <html><body><h1>504 Gateway Time-out</h1>\nThe server didn\'t respond in time.\n</body></html>\n\n " ' +
			'Headers: { "set-cookie": [ "_gh_sess=secret-cookie-value", "logged_in=no" ] }';

		beforeEach(() => {
			vi.useFakeTimers();
			mockAutoUpdater.checkForUpdates.mockReset();
			mockAutoUpdater.downloadUpdate.mockReset();
			mockAutoUpdater.setFeedURL.mockReset();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		async function getDownloadHandler() {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0]);
			const handler = ipcHandlers.get('updates:download');
			expect(handler).toBeTruthy();
			return handler!;
		}

		it('retries a transient 504 on the pre-download check and then succeeds', async () => {
			mockAutoUpdater.checkForUpdates
				.mockRejectedValueOnce(new Error(raw504))
				.mockResolvedValueOnce({ updateInfo: { version: '1.2.3' } });
			mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

			const handler = await getDownloadHandler();
			const resultPromise = handler();
			await vi.runAllTimersAsync();
			const result = await resultPromise;

			expect(result).toEqual({ success: true });
			expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
			expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
		});

		it('gives up after max attempts and returns a friendly, sanitized error', async () => {
			mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error(raw504));

			const handler = await getDownloadHandler();
			const resultPromise = handler();
			await vi.runAllTimersAsync();
			const result = (await resultPromise) as { success: boolean; error: string };

			expect(result.success).toBe(false);
			// Three attempts: 1 initial + 2 retries.
			expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
			// Friendly message, not the raw HTML/header/cookie blob.
			expect(result.error).toContain('GitHub is temporarily unavailable');
			expect(result.error).toContain('HTTP 504');
			expect(result.error).not.toContain('<html>');
			expect(result.error).not.toContain('set-cookie');
			expect(result.error).not.toContain('_gh_sess');
		});

		it('points electron-updater at the CDN release assets when given a target tag', async () => {
			mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.3' } });
			mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

			const handler = await getDownloadHandler();
			const resultPromise = handler({}, 'v1.2.3');
			await vi.runAllTimersAsync();
			const result = await resultPromise;

			expect(result).toEqual({ success: true });
			// Generic provider pointed at the release's CDN-served asset directory,
			// bypassing releases.atom entirely.
			expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
				provider: 'generic',
				url: 'https://github.com/RunMaestro/Maestro/releases/download/v1.2.3/',
			});
		});

		it('falls back to the default GitHub provider when no tag is supplied', async () => {
			mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.3' } });
			mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

			const handler = await getDownloadHandler();
			const resultPromise = handler();
			await vi.runAllTimersAsync();
			await resultPromise;

			expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
		});

		it('does not retry a non-transient error', async () => {
			mockAutoUpdater.checkForUpdates.mockRejectedValue(
				new Error('ENOSPC: no space left on device')
			);

			const handler = await getDownloadHandler();
			const resultPromise = handler();
			await vi.runAllTimersAsync();
			const result = (await resultPromise) as { success: boolean; error: string };

			expect(result.success).toBe(false);
			expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
			expect(result.error).toContain('ENOSPC');
		});
	});
});
