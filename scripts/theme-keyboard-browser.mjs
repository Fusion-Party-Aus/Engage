// Shared-theme keyboard regression checks for the built application.
//
// Uses only synthetic APP_MODE=preview accounts and an in-memory database.
// Application credentials are not inherited. External browser requests are
// intercepted; this never visits or modifies a production service.
//
// Build first, then run:
// ENGAGE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/theme-keyboard-browser.mjs
//
// Screenshots and report.json default to the ignored docs/screenshots/theme-keyboard
// directory. ENGAGE_THEME_KEYBOARD_OUTPUT can select another output directory.
// No Playwright dependency is added to the application.
//
// Checks visible skip links, page guidance, public navigation, and admin drawer
// opening focus, Tab containment, closing focus return and responsive resizing.
// Drawer checks run both with reduced motion and with normal motion. Assertions
// and a bounded runtime produce a non-zero exit for failures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath)
    throw new Error('Set ENGAGE_PLAYWRIGHT_MODULE to an isolated Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(path.resolve(modulePath)).href);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.ENGAGE_THEME_KEYBOARD_OUTPUT || path.join(root, 'docs/screenshots/theme-keyboard'));
await access(path.join(root, 'dist/server/entry.mjs'));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
        NODE_ENV: 'production', APP_MODE: 'preview', HOST: '127.0.0.1', PORT: String(port),
        MONGODB_URI: '', MONGODB_DB_NAME: '', PUBLIC_ORIGIN: origin, BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: 'isolated-keyboard-review-secret-no-production-use',
        LEGAL_ACCEPTANCE_ENABLED: 'false', TURNSTILE_ENFORCEMENT: 'off',
    } });
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });
let browser;
const results = [];
const deadline = setTimeout(() => {
    process.exitCode = 1;
    console.error('Theme keyboard verification exceeded 180 seconds.');
    server.kill('SIGTERM');
    void browser?.close();
}, 180000);
process.once('exit', () => {
    if (server.exitCode === null && server.signalCode === null)
        server.kill('SIGKILL');
});
const settle = async (page) => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(150);
};
const focused = page => page.evaluate(() => {
    const element = document.activeElement, rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const centre = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { tag: element.tagName, label: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 70), outline: style.outline, outlineWidth: parseFloat(style.outlineWidth), shadow: style.boxShadow, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, focusVisible: element.matches(':focus-visible'), visible: !!centre && (centre === element || element.contains(centre)), insideSidebar: !!element.closest('#admin-sidebar') };
});
try {
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
        if (server.exitCode !== null)
            throw new Error(`Fixture exited ${server.exitCode}: ${serverLog}`);
        try {
            if ((await fetch(`${origin}/member/`, { signal: AbortSignal.timeout(1500) })).ok) {
                ready = true;
                break;
            }
        }
        catch { }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready)
        throw new Error('Local isolated fixture did not start');
    await new Promise(resolve => setTimeout(resolve, 50));
    if (server.exitCode !== null)
        throw new Error(`Fixture exited after readiness: ${serverLog}`);
    browser = await chromium.launch({ headless: true });
    for (const item of [{ name: 'home-mobile', route: '/', actor: 'guest', width: 390, height: 844 }, { name: 'home-desktop', route: '/', actor: 'guest', width: 1440, height: 1000 }, { name: 'admin-mobile', route: '/admin/', actor: 'administrator', width: 390, height: 844 }, { name: 'admin-mobile-motion', route: '/admin/', actor: 'administrator', width: 390, height: 844, motion: 'no-preference' }]) {
        const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, reducedMotion: item.motion || 'reduce' });
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 204, body: '' }));
        if (item.actor !== 'guest')
            await context.addCookies([{ name: 'engage_dev_user', value: item.actor, url: origin }]);
        const page = await context.newPage();
        const response = await page.goto(`${origin}${item.route}`, { waitUntil: 'networkidle' });
        assert.equal(response.status(), 200, `${item.name} should return HTTP 200`);
        assert.equal(new URL(page.url()).pathname, item.route, `${item.name} should reach its expected route`);
        await page.evaluate(() => document.fonts.ready);
        const steps = [];
        for (let step = 0; step < 8; step += 1) {
            await page.keyboard.press('Tab');
            await settle(page);
            steps.push(await focused(page));
            if (step === 0)
                await page.screenshot({ path: `${output}/${item.name}-skip-link.png` });
        }
        const help = page.locator('.page-help__disclosure > summary');
        await help.focus();
        await page.keyboard.press('Space');
        await settle(page);
        const guidance = await help.evaluate(element => ({ open: element.parentElement.open, outline: getComputedStyle(element).outline, overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
        await page.screenshot({ path: `${output}/${item.name}-guidance.png` });
        await page.keyboard.press('Space');
        let navigation = null;
        if (item.name === 'home-mobile') {
            await page.locator('.site-menu__toggle').focus();
            await page.keyboard.press('Space');
            await settle(page);
            navigation = await page.locator('.site-menu').evaluate(element => ({ open: element.open, links: [...element.querySelectorAll('a')].map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') })), overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
            await page.screenshot({ path: `${output}/${item.name}-menu.png` });
            await page.keyboard.press('Escape');
            navigation.closedWithEscape = !(await page.locator('.site-menu').evaluate(element => element.open));
            navigation.focusReturned = await page.locator('.site-menu__toggle').evaluate(element => element === document.activeElement);
        }
        else if (item.actor === 'administrator') {
            const toggle = page.locator('[data-sidebar-toggle]');
            await toggle.focus();
            await page.keyboard.press('Space');
            await settle(page);
            navigation = await page.locator('[data-admin-shell]').evaluate(element => ({ open: element.dataset.sidebarOpen, overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
            navigation.focusOnOpen = await focused(page);
            await page.keyboard.press('Tab');
            await settle(page);
            navigation.nextFocus = await focused(page);
            await page.screenshot({ path: `${output}/${item.name}-drawer.png` });
            await page.locator('.admin-user-menu > summary').focus();
            await page.keyboard.press('Tab');
            await settle(page);
            navigation.tabWrapsToFirst = await page.locator('.admin-brand').evaluate(element => element === document.activeElement);
            await page.keyboard.press('Shift+Tab');
            await settle(page);
            navigation.shiftTabWrapsToLast = await page.locator('.admin-user-menu > summary').evaluate(element => element === document.activeElement);
            await page.keyboard.press('Escape');
            navigation.closedWithEscape = (await page.locator('[data-admin-shell]').getAttribute('data-sidebar-open')) === 'false';
            navigation.escapeReturnsFocus = await toggle.evaluate(element => element === document.activeElement);
            await page.keyboard.press('Enter');
            await settle(page);
            await page.locator('[data-sidebar-close]').press('Enter');
            await settle(page);
            navigation.closeReturnsFocus = await toggle.evaluate(element => element === document.activeElement);
            navigation.closeClosesDrawer = (await page.locator('[data-admin-shell]').getAttribute('data-sidebar-open')) === 'false';
            await page.keyboard.press('Enter');
            await settle(page);
            await page.locator('[data-sidebar-scrim]').click({ position: { x: 375, y: 400 } });
            await settle(page);
            navigation.scrimReturnsFocus = await toggle.evaluate(element => element === document.activeElement);
            navigation.scrimClosesDrawer = (await page.locator('[data-admin-shell]').getAttribute('data-sidebar-open')) === 'false';
            await page.keyboard.press('Enter');
            await settle(page);
            await page.setViewportSize({ width: 1440, height: 1000 });
            await settle(page);
            navigation.desktopResize = await page.evaluate(() => ({ open: document.querySelector('[data-admin-shell]').dataset.sidebarOpen, locked: document.body.classList.contains('admin-nav-open'), scrimHidden: document.querySelector('[data-sidebar-scrim]').hidden, focusOnTrigger: document.activeElement === document.querySelector('[data-sidebar-toggle]') }));
            await page.locator('.admin-user-menu > summary').focus();
            await page.keyboard.press('Tab');
            await settle(page);
            navigation.desktopTabNotTrapped = await toggle.evaluate(element => element === document.activeElement);
            await page.locator('.admin-brand').focus();
            await page.setViewportSize({ width: 390, height: 844 });
            await settle(page);
            navigation.mobileResize = await page.evaluate(() => ({ open: document.querySelector('[data-admin-shell]').dataset.sidebarOpen, locked: document.body.classList.contains('admin-nav-open'), focusOnTrigger: document.activeElement === document.querySelector('[data-sidebar-toggle]') }));
            await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
            await settle(page);
            await page.screenshot({ path: `${output}/${item.name}-final-full.png`, fullPage: true });
        }
        results.push({ ...item, steps, guidance, navigation });
        console.log(JSON.stringify({ page: item.name, focusProblems: steps.filter(step => !step.visible || step.outlineWidth <= 0), guidance, navigation }));
        await context.close();
    }
    const passed = results.every(result => {
        if (!result.steps.every(step => step.visible && step.focusVisible && step.outlineWidth > 0) || !result.guidance.open || result.guidance.overflow)
            return false;
        const nav = result.navigation;
        if (!nav)
            return true;
        if (result.name === 'home-mobile')
            return nav.open && !nav.overflow && nav.closedWithEscape && nav.focusReturned;
        return nav.open === 'true' && !nav.overflow && nav.focusOnOpen.visible && nav.focusOnOpen.label === 'Close navigation' && nav.nextFocus.visible && nav.nextFocus.insideSidebar && nav.tabWrapsToFirst && nav.shiftTabWrapsToLast && nav.closedWithEscape && nav.escapeReturnsFocus && nav.closeReturnsFocus && nav.closeClosesDrawer && nav.scrimReturnsFocus && nav.scrimClosesDrawer && nav.desktopResize.open === 'false' && !nav.desktopResize.locked && nav.desktopResize.scrimHidden && nav.desktopResize.focusOnTrigger && nav.desktopTabNotTrapped && nav.mobileResize.open === 'false' && !nav.mobileResize.locked && nav.mobileResize.focusOnTrigger;
    });
    await writeFile(`${output}/report.json`, JSON.stringify({ isolatedPreviewOnly: true, dynamicPort: port, childServerAlive: server.exitCode === null, passed, results }, null, 2));
    assert.equal(passed, true, `Keyboard verification failed; inspect ${path.join(output, 'report.json')}`);
    assert.equal(server.exitCode, null, 'The isolated preview server should remain alive throughout the checks');
}
finally {
    try {
        await browser?.close();
    }
    finally {
        clearTimeout(deadline);
        if (server.exitCode === null && server.signalCode === null) {
            const exited = new Promise(resolve => server.once('exit', resolve));
            const forceStop = setTimeout(() => server.kill('SIGKILL'), 3000);
            server.kill('SIGTERM');
            await exited;
            clearTimeout(forceStop);
        }
        await writeFile(path.join(output, 'server.log'), serverLog);
    }
}
