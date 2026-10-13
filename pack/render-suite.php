<?php
// SPDX-License-Identifier: Apache-2.0
/**
 * render-suite.php — render one app's browser-edition page again, for Studio (H.2, H.6). Runs on the site (needs the
 * Catalog and the app's source build for ui.inc/settings.inc), as www-data:
 *
 *   php render-suite.php <slug> <build> <edition-dir> <siblings.json> <out.html>
 *
 * Stages the page exactly as devshell/edition.php step 6 does (render.php --edition from a temporary dev shell over the
 * edition's own build), with suite-stubs.php loaded first so the apps beside it in the suite count as present.
 * <siblings.json> = {"<slug>": {"accepts": [...]}, …}; with {} the result must equal the edition's own index.html —
 * suite.mjs checks that before trusting a suite render, so a change in the edition packer can't slip through unseen.
 * Exit 0 ok, 1 failure (message on stderr).
 */

declare(strict_types=1);

$site = getenv('CADCRAFT_SITE') ?: '';
if ($site === '') { fwrite(STDERR, basename(__FILE__) . ": CADCRAFT_SITE is not set: point it at the site's folder\n"); exit(1); }
require_once $site . '/public_html/core/bootstrap.php';
require_once $site . '/devshell/edition.php';

[$slug, $build, $ed, $siblingsFile, $outFile] = array_slice($argv, 1) + [null, null, null, null, null];
$fail = static function (string $m): never { fwrite(STDERR, "render-suite: $m\n"); exit(1); };
if (!$slug || !$build || !$ed || !$siblingsFile || !$outFile) $fail('usage: render-suite.php <slug> <build> <edition-dir> <siblings.json> <out.html>');
$app = Catalog::app($slug) ?? $fail("unknown app $slug");
$pub = CC_PUBLIC;
$src = realpath(AppBuilds::root($slug) . "/$build") ?: $fail("no build $build for $slug");
$ed = realpath($ed) ?: $fail("no edition at {$argv[3]}");
$appRel = "assets/apps/$slug/$build";
if (!is_dir("$ed/$appRel")) $fail("$ed has no $appRel");
if (!is_array(json_decode((string)@file_get_contents($siblingsFile), true))) $fail('siblings file is not a JSON object');

// The same library facts edition_pack() wrote into app.json (step 3).
$libs = edition_libs($src, $pub);
$shell = edition_shell_libs($pub);
foreach ($shell as $lib => $s) $libs[$lib] = $s['version'];

// The same offline list (step 6): every file of the edition but sw.js, docs and license texts.
$offline = [];
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($ed, FilesystemIterator::SKIP_DOTS)) as $f) {
    $rel = substr($f->getPathname(), strlen($ed) + 1);
    if (preg_match('#^(sw\.js|offline\.json|index\.html|release\.json|\.edition-notes\.json|\.htaccess|web\.config)$|\.(md|txt|map)$|(^|/)(LICENSE|NOTICE|SOURCE)[^/]*$#i', $rel)) continue;
    $offline[] = $rel;
}
sort($offline);

$copyTree = static function (string $from, string $to) use (&$copyTree): void {
    @mkdir($to, 0775, true);
    foreach (scandir($from) ?: [] as $n) {
        if ($n === '.' || $n === '..') continue;
        is_dir("$from/$n") ? $copyTree("$from/$n", "$to/$n") : copy("$from/$n", "$to/$n");
    }
};

$stage = sys_get_temp_dir() . '/cc-studio-' . bin2hex(random_bytes(4));
@mkdir("$stage/devshell/site/core/components", 0775, true);
@mkdir("$stage/devshell/site/core/classes", 0775, true);
foreach (['render.php', 'stubs.php'] as $f) copy("$site/devshell/$f", "$stage/devshell/$f");
copy("$pub/core/components/app-settings.inc", "$stage/devshell/site/core/components/app-settings.inc");
copy("$pub/core/classes/Lang.php", "$stage/devshell/site/core/classes/Lang.php");
$copyTree("$pub/assets/lang/shell", "$stage/devshell/site/assets/lang/shell");
$copyTree("$ed/$appRel", "$stage/app");
foreach (['ui.inc', 'settings.inc'] as $f) if (is_file("$src/$f")) copy("$src/$f", "$stage/app/$f");
file_put_contents("$stage/offline.json", json_encode($offline, JSON_UNESCAPED_SLASHES));
$others = [];
foreach (Catalog::apps() as $a) if ($a['slug'] !== $slug) $others[$a['slug']] = $a['name'];
file_put_contents("$stage/devshell/app.json", json_encode([
    'format' => 'cadcraft-devshell', 'version' => 1,
    'app' => array_intersect_key($app, array_flip(['slug', 'name', 'layer', 'role', 'short', 'tagline'])),
    'others' => $others, 'vendor' => $libs,
    'shell' => array_map(static fn($s) => $s['version'], $shell),
    'origin' => EDITION_SITE, 'packed' => ['at' => gmdate('Y-m-d\TH:i:s\Z'), 'build' => $build],
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

$env = ['STUDIO_SIBLINGS' => realpath($siblingsFile), 'PATH' => getenv('PATH') ?: '/usr/bin:/bin'];
$p = proc_open([PHP_BINARY, '-d', 'auto_prepend_file=' . __DIR__ . '/suite-stubs.php', "$stage/devshell/render.php", '--edition', $build, '--out', $outFile],
    [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
$msg = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
$code = proc_close($p);
exec('rm -rf ' . escapeshellarg($stage));
if ($code !== 0) $fail("render failed:\n$msg");
exit(0);
