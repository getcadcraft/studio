<?php
// SPDX-License-Identifier: Apache-2.0
/**
 * suite-stubs.php — loaded before devshell/stubs.php (php -d auto_prepend_file) when render-suite.php re-renders an app's
 * edition page for Studio. Same Catalog and AppBuilds as devshell/stubs.php, with one difference: the other apps of the
 * suite ARE here (side by side under apps/<slug>/), so ui.inc's "Edit in <app>", "Open in 3D", "Open in TakeoffCraft"… show
 * for every sibling whose build takes a handoff (H.6). Siblings: the JSON file named by STUDIO_SIBLINGS,
 * {"<slug>": {"accepts": ["handoff"]}, …} — an empty object renders exactly the edition's own page (checked by the packer).
 */

declare(strict_types=1);

function studio_siblings(): array
{
    static $s = null;
    if ($s === null) {
        $f = getenv('STUDIO_SIBLINGS');
        $s = $f && is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
    }
    return $s;
}

final class Catalog
{
    /** The app this page runs, or one of the other apps (name only). */
    public static function app(string $slug): ?array
    {
        $d = devshell_app();
        if ($slug === $d['app']['slug']) return $d['app'];
        return isset($d['others'][$slug]) ? ['slug' => $slug, 'name' => $d['others'][$slug], 'open_in' => []] : null;
    }
    /** This app, and every app of the suite beside it. */
    public static function openIn(array $app, string $area): bool
    {
        return $app['slug'] === devshell_app()['app']['slug'] || ($area === 'edition' && isset(studio_siblings()[$app['slug']]));
    }
    public static function areas(): array { return []; }
}

final class AppBuilds
{
    public const PANEL_FEATURES = ['move', 'window'];
    public const PANELS_SCRIPT = '/assets/js/app-panels.js';

    public static function panels(array $build): array
    {
        $want = $build['manifest']['panels'] ?? [];
        return is_array($want) ? array_values(array_intersect(self::PANEL_FEATURES, $want)) : [];
    }
    // Mirrors of devshell/stubs.php (phones, track PH; menus, keys and mouse, track IP): render.php calls them. Added by the
    // final sweep's live-finish worker so the suite packs again — keep them in step with devshell/stubs.php.
    public const PHONE_SCRIPT = '/assets/js/app-phone.js';
    public static function phone(array $build): ?array
    {
        $p = $build['manifest']['phone'] ?? null;
        if ($p === true) return [];
        if (!is_array($p)) return null;
        $out = [];
        foreach (['stage', 'toolbar', 'options', 'hint', 'keep', 'sheets'] as $k) if (isset($p[$k]) && is_string($p[$k]) && strlen($p[$k]) <= 400) $out[$k] = $p[$k];
        return $out;
    }
    public const INPUT_SCRIPT = '/assets/js/app-input-ui.js';
    public const INPUT_ENGINE = '/assets/js/app-input.js';
    public const INPUT_CSS = '/assets/css/app-input.css';
    public static function input(array $build): ?string
    {
        $f = $build['manifest']['input'] ?? null;
        if (!is_string($f) || !preg_match('/^input-[a-z0-9-]+\.js$/', $f) || !is_file(($build['dir'] ?? '') . '/' . $f)) return null;
        return $build['url'] . $f;
    }
    public static function wideSettings(array $build): bool
    {
        $v = (string)($build['version'] ?? '');
        return !empty($build['is_dev']) || (preg_match('/^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/', $v) === 1 && version_compare($v, '0.5', '>='));
    }
    // 0.7 mirrors (hardware specs HW.2, workspace layouts WS.6; closing part 2), copied from devshell/stubs.php — keep in step.
    /** Hardware specs from the six apps without lib/compute (0.7 HW.2), as the site's AppBuilds::hardware. */
    public const HARDWARE_SCRIPT = '/assets/js/app-hardware.js';
    public static function hardware(array $build): bool { return ($build['manifest']['hardware'] ?? false) === true; }
    /** Workspace layouts (0.7 WS.6), as the site's AppBuilds::workspaces / workspaceAdapter / hasWorkspaces / workspaceConfig. */
    public const WORKSPACE_BUILTINS = ['docked', 'toolbox'];
    public const WORKSPACE_MODULES = ['/assets/js/app-workspace.js', '/assets/js/app-workspace-format.js', '/assets/js/app-workspace-popout.js', '/assets/js/app-workspace-input.js', '/assets/js/app-workspace-extras.js', '/assets/js/app-workspace-arrange.js', '/assets/js/i18n.js'];
    public static function workspaces(array $build): array
    {
        $w = $build['manifest']['workspaces'] ?? [];
        if (is_array($w) && isset($w['layouts'])) $w = $w['layouts'];
        return is_array($w) ? array_values(array_intersect(self::WORKSPACE_BUILTINS, $w)) : [];
    }
    public static function workspaceAdapter(array $build): ?string
    {
        $f = $build['manifest']['workspaces']['adapter'] ?? null;
        return is_string($f) && preg_match('/^workspace-[a-z0-9-]+\.js$/', $f) && is_file(($build['dir'] ?? '') . '/' . $f) ? $f : null;
    }
    public static function hasWorkspaces(array $build): bool { return (bool)self::workspaces($build) || self::workspaceAdapter($build) !== null; }
    /** The built-in layouts' text from the shell's copy (site/assets/workspaces); add-ons of the build from its workspace/index.json. */
    public static function workspaceConfig(array $build, array $app): array
    {
        $builtins = [];
        foreach (self::workspaces($build) as $id) { $f = CC_PUBLIC . '/assets/workspaces/' . $id . '.ccworkspace.json'; if (is_file($f) && filesize($f) <= 65536) $builtins[$id] = (string)file_get_contents($f); }
        $addons = [];
        $ix = json_decode((string)@file_get_contents(($build['dir'] ?? '') . '/workspace/index.json'), true);
        if (is_array($ix) && ($ix['format'] ?? '') === 'cadcraft-workspace-addons' && ($ix['version'] ?? null) === 1 && is_array($ix['addons'] ?? null)) {
            foreach (array_slice($ix['addons'], 0, 50) as $p) {
                $file = (string)($p['file'] ?? '');
                $path = $build['dir'] . '/workspace/' . $file;
                if (!preg_match('/^[a-z0-9][a-z0-9.-]{0,80}\.ccworkspace\.json$/', $file) || !is_file($path) || filesize($path) > 65536) continue;
                $addons[] = ['id' => (string)($p['id'] ?? ''), 'file' => $file, 'name' => (string)($p['name'] ?? ''), 'text' => (string)file_get_contents($path)];
            }
        }
        return ['app' => $app['slug'], 'appName' => $app['name'], 'layouts' => array_keys($builtins), 'builtins' => (object)$builtins, 'addons' => $addons];
    }
    /** A sibling's build: only what ui.inc reads (its manifest's "accepts"). */
    public static function resolve(string $slug, string $area, ?string $version = null): ?array
    {
        $s = studio_siblings()[$slug] ?? null;
        if ($area !== 'edition' || $s === null) return null;
        return ['slug' => $slug, 'version' => 'suite', 'manifest' => ['accepts' => array_values(array_filter((array)($s['accepts'] ?? []), 'is_string'))]];
    }
    public static function versions(string $slug): array { return []; }
    public static function hasDev(string $slug): bool { return false; }
}
