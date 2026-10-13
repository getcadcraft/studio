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
