import test from 'node:test';
import assert from 'node:assert';
import * as path from 'path';

// ios-onboarding.js es un script de browser plano (sin tipos ni allowJs habilitado en tsconfig),
// se carga con require() en vez de import para no forzar allowJs a nivel de proyecto (rompería
// tsc --noEmit sobre el resto de src/dashboard/*.js, que asumen globals de browser).
const { isIosDevice, isRunningAsInstalledPwa, shouldShowIosInstallOnboarding } = require(path.join('..', 'src', 'dashboard', 'ios-onboarding'));

function nav(overrides: Partial<{ userAgent: string; platform: string; maxTouchPoints: number; standalone: boolean }> = {}) {
  return { userAgent: '', platform: '', maxTouchPoints: 0, ...overrides } as any;
}

function win(matches: boolean) {
  return { matchMedia: () => ({ matches }) } as any;
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const IPAD_CLASSIC_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const DESKTOP_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36';

test('ios-onboarding.isIosDevice - detecta iPhone por user agent', () => {
  assert.strictEqual(isIosDevice(nav({ userAgent: IPHONE_UA })), true);
});

test('ios-onboarding.isIosDevice - detecta iPad clásico por user agent', () => {
  assert.strictEqual(isIosDevice(nav({ userAgent: IPAD_CLASSIC_UA })), true);
});

test('ios-onboarding.isIosDevice - detecta iPadOS 13+ (UA de Safari de escritorio con touch)', () => {
  assert.strictEqual(isIosDevice(nav({ userAgent: DESKTOP_SAFARI_UA, platform: 'MacIntel', maxTouchPoints: 5 })), true);
});

test('ios-onboarding.isIosDevice - NO detecta un Mac real (mismo UA, sin touch)', () => {
  assert.strictEqual(isIosDevice(nav({ userAgent: DESKTOP_SAFARI_UA, platform: 'MacIntel', maxTouchPoints: 0 })), false);
});

test('ios-onboarding.isIosDevice - NO detecta Android', () => {
  assert.strictEqual(isIosDevice(nav({ userAgent: ANDROID_UA, maxTouchPoints: 5 })), false);
});

test('ios-onboarding.isRunningAsInstalledPwa - true vía navigator.standalone (iOS)', () => {
  assert.strictEqual(isRunningAsInstalledPwa(nav({ standalone: true }), win(false)), true);
});

test('ios-onboarding.isRunningAsInstalledPwa - true vía matchMedia display-mode: standalone', () => {
  assert.strictEqual(isRunningAsInstalledPwa(nav({ standalone: false }), win(true)), true);
});

test('ios-onboarding.isRunningAsInstalledPwa - false cuando corre en una pestaña normal', () => {
  assert.strictEqual(isRunningAsInstalledPwa(nav({ standalone: false }), win(false)), false);
});

test('ios-onboarding.shouldShowIosInstallOnboarding (KAN-47 AC1/AC2) - true en iPhone sin instalar', () => {
  assert.strictEqual(shouldShowIosInstallOnboarding(nav({ userAgent: IPHONE_UA }), win(false)), true);
});

test('ios-onboarding.shouldShowIosInstallOnboarding - false en iPhone ya instalado como PWA', () => {
  assert.strictEqual(shouldShowIosInstallOnboarding(nav({ userAgent: IPHONE_UA, standalone: true }), win(false)), false);
});

test('ios-onboarding.shouldShowIosInstallOnboarding - false en un dispositivo que no es iOS', () => {
  assert.strictEqual(shouldShowIosInstallOnboarding(nav({ userAgent: ANDROID_UA }), win(false)), false);
});
